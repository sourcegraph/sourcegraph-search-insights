import * as sourcegraph from 'sourcegraph'
import gql from 'tagged-template-noop'
import { IQuery, IGraphQLResponseRoot, ISearch, ICommitSearchResult } from './graphql-schema'
import { resolveDocumentURI } from './uri'
import { sub, add, Duration, startOfDay } from 'date-fns'
import { from, defer } from 'rxjs'
import { map, distinctUntilChanged, mergeAll, startWith, retry } from 'rxjs/operators'
import isEqual from 'lodash/isEqual'
import sortBy from 'lodash/sortBy'
import escapeRegExp from 'lodash/escapeRegExp'

const queryGraphQL = async <T = IQuery>(query: string, variables: object = {}): Promise<T> => {
    const { data, errors }: IGraphQLResponseRoot = await sourcegraph.commands.executeCommand(
        'queryGraphQL',
        query,
        variables
    )
    if (errors && errors.length > 0) {
        throw new Error(errors.map(e => e.message).join('\n'))
    }
    return (data as any) as T
}

interface Insight {
    title: string
    description?: string
    series: {
        name: string
        query: string
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

    context.subscriptions.add(
        insightChanges.pipe(mergeAll()).subscribe(([id, insight]) => {
            if (!insight) {
                return
            }
            console.log('Registering search insights provider', id)
            // TODO diff and unregister removed insights
            context.subscriptions.add(
                sourcegraph.app.registerViewProvider(`searchInsights.${id}`, createViewProvider(insight))
            )
        })
    )
}

function createViewProvider(insight: Insight): sourcegraph.ViewProvider {
    const step = insight.step || { days: 1 }

    return {
        where: 'directory',
        provideView: async ({ viewer }) => {
            // TODO support configuration of repositories
            // Currently only searches current repo
            if (insight.repositories) {
                throw new Error('Configuration of repositories is not supported yet.')
            }

            const { repo, path } = resolveDocumentURI(viewer.directory.uri)
            const repoRegexp = `^${escapeRegExp(repo)}$`
            const pathRegexp = path ? `^${escapeRegExp(path)}/` : undefined

            // Get days to query
            const now = startOfDay(new Date())
            const dates: Date[] = []
            for (let i = 0, d = now; i < 7; i++) {
                dates.unshift(d)
                d = sub(d, step)
            }

            // Get commits to search for each day
            const commitOids = await determineCommitsToSearch(dates, step, repoRegexp)
            const searchQueries = insight.series.flatMap(({ query }) =>
                commitOids.map(oid =>
                    [`repo:${repoRegexp}@${oid}`, pathRegexp && ` file:${pathRegexp}`, query, 'count:99999']
                        .filter(Boolean)
                        .join(' ')
                )
            )
            const searchResults = await defer(() =>
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
                    Object.fromEntries(searchQueries.map((query, i) => [`query${i}`, query]))
                )
            )
                // The bulk search may timeout, but a retry is then likely faster because caches are warm
                .pipe(retry(3))
                .toPromise()

            const data: {
                date: number
                [seriesName: string]: number
            }[] = []
            for (const [field, result] of Object.entries(searchResults)) {
                const i = +field.slice('search'.length)
                const date = dates[i % dates.length]
                const dataKey = insight.series[Math.floor(i / dates.length)].name
                const obj = data[i % dates.length] ?? (data[i % dates.length] = { date: date.getTime() })
                const count = result.results.matchCount
                obj[dataKey] = count
            }
            return {
                title: insight.title,
                content: [
                    ...(insight.description
                        ? [{ kind: sourcegraph.MarkupKind.Markdown, value: insight.description }]
                        : []),
                    {
                        chart: 'line' as const,
                        data,
                        series: insight.series.map(query => ({
                            dataKey: query.name,
                            name: query.name,
                            stroke: 'var(--warning)',
                            linkURLs: dates.map(date => {
                                // Link to diff search that explains what new cases were added between two data points
                                const url = new URL('/search', sourcegraph.internal.sourcegraphURL)
                                const after = sub(date, step).toISOString()
                                const before = date.toISOString()
                                const diffQuery = `type:diff after:${after} before:${before} ${query.query}`
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
        },
    }
}

async function determineCommitsToSearch(
    dates: Date[],
    step: globalThis.Duration,
    repoRegexp: string
): Promise<string[]> {
    const commitQueries = dates.map(date => {
        const before = add(date, step).toISOString()
        const after = date.toISOString()
        return `repo:${repoRegexp} type:commit before:${before} after:${after} count:1`
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
    const commitOids = sortBy(
        Object.entries(commitResults).map(([name, result]) => [+name.slice('search'.length), result] as const),
        0
    ).map(([i, search]) => {
        if (search.results.results.length === 0) {
            throw new Error(`No result for ${commitQueries[i]}`)
        }
        return (search.results.results[0] as ICommitSearchResult).commit.oid
    })

    return commitOids
}
