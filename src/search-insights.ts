import * as sourcegraph from 'sourcegraph'
import gql from 'tagged-template-noop'
import { IQuery, IGraphQLResponseRoot, ISearch, ICommitSearchResult } from './graphql-schema'
import { resolveDocumentURI } from './uri'
import { sub, Duration, startOfDay, isAfter, formatISO } from 'date-fns'
import { from, defer, Subscription } from 'rxjs'
import { map, distinctUntilChanged, mergeAll, startWith, retry, tap } from 'rxjs/operators'
import isEqual from 'lodash/isEqual'
import escapeRegExp from 'lodash/escapeRegExp'
import { queryHasCountFilter } from './query-has-count-filter'

const queryGraphQL = async <T = IQuery>(query: string, variables: object = {}): Promise<T> => {
    const { data, errors }: IGraphQLResponseRoot = await sourcegraph.commands.executeCommand(
        'queryGraphQL',
        query,
        variables
    )
    if (errors && errors.length > 0) {
        throw new Error(errors.map(e => e.message).join('\n'))
    }
    return data as any as T
}

/**
 * Special empty data point value for line chart.
 */
const EMPTY_DATA_POINT_VALUE = null

interface Insight {
    title: string
    subtitle?: string
    description?: string
    series: {
        name: string
        query: string
        stroke?: string
    }[]
    step: Duration
    repositories?: 'current' | 'all' | string[]
}

export function activate(context: sourcegraph.ExtensionContext): void {
    const settings = from(sourcegraph.configuration).pipe(
        startWith(null),
        map(() => sourcegraph.configuration.get().value)
    )
    const insightChanges = settings.pipe(
        map(
            settings =>
                Object.entries(settings).filter(([key]) => key.startsWith('searchInsights.insight.')) as [
                    string,
                    Insight | null | false
                ][]
        ),
        distinctUntilChanged((a, b) => isEqual(a, b))
    )

    // Further in main context.subscriptions we have nested calls of context.subscriptions
    // as well, because of this we have to manage inner subscription ourselves. This
    // subscription bag needed to unsubscribe nested calls in a moment when user/org settings
    // have been updated.
    let previousSubscriptions = new Subscription()

    context.subscriptions.add(
        insightChanges
            .pipe(
                tap(() => {
                    previousSubscriptions.unsubscribe()
                    previousSubscriptions = new Subscription()
                    context.subscriptions.add(previousSubscriptions)
                }),
                mergeAll()
            )
            .subscribe(([id, insight]) => {
                if (!insight) {
                    return
                }
                const { repositories = 'current' } = insight

                // TODO diff and unregister removed insights
                if (repositories === 'current') {
                    context.subscriptions.add(
                        sourcegraph.app.registerViewProvider(`${id}.directory`, {
                            where: 'directory',
                            provideView: async ({ viewer }) => {
                                const { repo, path } = resolveDocumentURI(viewer.directory.uri)
                                return getInsightContent([repo], path, insight)
                            },
                        })
                    )
                } else if (Array.isArray(repositories)) {
                    const provideView = (): Promise<sourcegraph.View> =>
                        getInsightContent(repositories, undefined, insight)

                    const directoryPageProvider = sourcegraph.app.registerViewProvider(`${id}.directory`, {
                        where: 'directory',
                        provideView: async ({ viewer }) => {
                            const { repo, path } = resolveDocumentURI(viewer.directory.uri)
                            return getInsightContent([repo], path, insight)
                        },
                    })

                    const homePageProvider = sourcegraph.app.registerViewProvider(`${id}.homepage`, {
                        where: 'homepage',
                        provideView,
                    })

                    const insightPageProvider = sourcegraph.app.registerViewProvider(`${id}.insightsPage`, {
                        where: 'insightsPage',
                        provideView,
                    })

                    // Pass next providers to enclosure subscription bag in case if we got update
                    // from the user/org settings in order for us to be able to close provider observables.
                    previousSubscriptions.add(insightPageProvider)
                    previousSubscriptions.add(directoryPageProvider)
                    previousSubscriptions.add(homePageProvider)
                }
            })
    )
}

interface InsightSeriesData {
    date: number
    [seriesName: string]: number
}

interface RepoCommit {
    date: Date
    commit: string
    repo: string
}

async function getInsightContent(
    repos: string[],
    path: string | undefined,
    insight: Insight
): Promise<sourcegraph.View> {
    const step = insight.step || { days: 1 }
    const dates = getDaysToQuery(step)

    const pathRegexp = path ? `^${escapeRegExp(path)}/` : undefined

    // -------- Initialize data ---------
    const data: InsightSeriesData[] = []

    for (const date of dates) {
        const dataIndex = dates.indexOf(date)

        // Initialize data series object by all dates.
        data[dataIndex] = {
            date: date.getTime(),
            // Initialize all series to 0
            ...Object.fromEntries(insight.series.map(series => [series.name, EMPTY_DATA_POINT_VALUE])),
        }
    }

    // Get commits to search for each day
    const repoCommits = (
        await Promise.all(
            repos.map(async repo => (await determineCommitsToSearch(dates, repo)).map(commit => ({ repo, ...commit })))
        )
    )
        .flat()
        // For commit which we can't find we should not run search API request
        // instead of it we will use just EMPTY_DATA_POINT_VALUE
        .filter(commitData => commitData.commit !== null) as RepoCommit[]

    const searchQueries = insight.series.flatMap(({ query, name }) =>
        repoCommits.map(({ date, repo, commit }) => ({
            name,
            date,
            repo,
            commit,
            query: [
                `repo:^${escapeRegExp(repo)}$@${commit}`,
                pathRegexp && ` file:${pathRegexp}`,
                getQueryWithCountFilter(query),
            ]
                .filter(Boolean)
                .join(' '),
        }))
    )
    const rawSearchResults = await defer(() =>
        queryGraphQL<Record<string, ISearch>>(
            gql`
                query BulkSearch(${searchQueries.map((_, i) => `$query${i}: String!`).join(', ')}) {
                    ${searchQueries
                        .map(
                            (_, i) => gql`
                                search${i}: search(version: V2, query: $query${i}) {
                                    results {
                                        matchCount
                                    }
                                }
                            `
                        )
                        .join('\n')}
                }
            `,
            Object.fromEntries(searchQueries.map(({ query }, i) => [`query${i}`, query]))
        )
    )
        // The bulk search may timeout, but a retry is then likely faster because caches are warm
        .pipe(retry(3))
        .toPromise()

    const searchResults = Object.entries(rawSearchResults).map(([field, result]) => {
        const index = +field.slice('search'.length)
        const query = searchQueries[index]
        return { ...query, result }
    })

    // Merge initial data and search API data
    for (const { name, date, result } of searchResults) {
        const dataKey = name
        const dataIndex = dates.indexOf(date)
        const object = data[dataIndex]

        const countForRepo = result?.results.matchCount

        // If we got some data that means for this data points we got
        // a valid commit in a git history therefore we need write some data
        // to this series.
        if (object[dataKey] === EMPTY_DATA_POINT_VALUE) {
            object[dataKey] = countForRepo ?? 0
        } else {
            object[dataKey] += countForRepo ?? 0
        }
    }

    return {
        title: insight.title,
        subtitle: insight.subtitle,
        content: [
            {
                chart: 'line' as const,
                data,
                series: insight.series.map(series => ({
                    dataKey: series.name,
                    name: series.name,
                    stroke: series.stroke,
                    linkURLs: dates.map(date => {
                        // Link to diff search that explains what new cases were added between two data points
                        const url = new URL('/search', sourcegraph.internal.sourcegraphURL)
                        // Use formatISO instead of toISOString(), because toISOString() always outputs UTC.
                        // They mark the same point in time, but using the user's timezone makes the date string
                        // easier to read (else the date component may be off by one day)
                        const after = formatISO(sub(date, step))
                        const before = formatISO(date)
                        const repoFilter = `repo:^(${repos.map(escapeRegExp).join('|')})$`
                        const diffQuery = `${repoFilter} type:diff after:${after} before:${before} ${series.query}`
                        url.searchParams.set('q', diffQuery)
                        return url.href
                    }),
                })),
                xAxis: {
                    dataKey: 'date' as const,
                    type: 'number' as const,
                    scale: 'time' as const,
                },
            },
        ],
    }
}

function getDaysToQuery(step: globalThis.Duration): Date[] {
    const now = startOfDay(new Date())
    const dates: Date[] = []
    for (let i = 0, d = now; i < 7; i++) {
        dates.unshift(d)
        d = sub(d, step)
    }
    return dates
}

interface SearchCommit {
    date: Date
    commit: string | null
}

async function determineCommitsToSearch(dates: Date[], repo: string): Promise<SearchCommit[]> {
    const commitQueries = dates.map(date => {
        const before = formatISO(date)
        return `repo:^${escapeRegExp(repo)}$ type:commit before:${before} count:1`
    })
    console.log('searching commits', commitQueries)
    const commitResults = await queryGraphQL<Record<string, ISearch>>(
        gql`
            query BulkSearchCommits(${commitQueries.map((_, i) => `$query${i}: String!`).join(', ')}) {
                ${commitQueries
                    .map(
                        (_, i) => gql`
                            search${i}: search(version: V2, patternType: literal, query: $query${i}) {
                                results {
                                    results {
                                        ... on CommitSearchResult {
                                            commit {
                                                oid
                                                committer {
                                                    date
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        `
                    )
                    .join('\n')}
            }
        `,
        Object.fromEntries(commitQueries.map((query, i) => [`query${i}`, query]))
    )
    const commitOids = Object.entries(commitResults).map(([name, search], index) => {
        const i = +name.slice('search'.length)
        const date = dates[i]

        if (i !== index) {
            throw new Error(`Expected field ${name} to be at index ${i} of object keys`)
        }

        if (search.results.results.length === 0) {
            console.warn(`No result for ${commitQueries[i]}`)

            return { commit: null, date }
        }
        const commit = (search.results.results[0] as ICommitSearchResult).commit

        // Sanity check
        const commitDate = commit.committer && new Date(commit.committer.date)

        if (!commitDate) {
            throw new Error(`Expected commit to have committer: \`${commit.oid}\``)
        }
        if (isAfter(commitDate, date)) {
            throw new Error(
                `Expected commit \`${commit.oid}\` to be before ${formatISO(date)}, but was after: ${formatISO(
                    commitDate
                )}.\nSearch query: ${commitQueries[i]}`
            )
        }

        return { commit: commit.oid, date }
    })

    return commitOids
}

function getQueryWithCountFilter(query: string): string {
    return queryHasCountFilter(query) ? query : `${query} count:99999`
}
