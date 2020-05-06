import * as sourcegraph from 'sourcegraph'
import gql from 'tagged-template-noop'
import { IQuery, IGraphQLResponseRoot, ISearch, ICommitSearchResult } from './graphql-schema'
import { resolveRootURI } from './uri'
import { eachDayOfInterval, sub, add } from 'date-fns'
import { from } from 'rxjs'
import { map, distinctUntilChanged, mergeAll, startWith } from 'rxjs/operators'
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
    query: string
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
                    Insight
                ][]
        ),
        distinctUntilChanged((a, b) => isEqual(a, b))
    )
    context.subscriptions.add(
        insightChanges.pipe(mergeAll()).subscribe(([id, insight]) => {
            console.log('registering', id)
            context.subscriptions.add(
                sourcegraph.app.registerViewProvider(`searchInsights.${id}`, {
                    where: 'directory',
                    provideView: async ({ workspace }) => {
                        // TODO support configuration of repositories
                        // Currently only searches current repo
                        const { repo } = resolveRootURI(workspace.uri)
                        const repoRegexp = `^${escapeRegExp(repo)}$`

                        // Get days to query
                        const now = new Date()
                        const dates = eachDayOfInterval({ start: sub(now, { days: 7 }), end: now })
                        console.log('dates', dates)

                        // Get commits to search for each  day
                        const commitQueries = dates.map(date => {
                            const before = add(date, { days: 1 }).toISOString()
                            const after = date.toISOString()
                            return `repo:${repoRegexp} type:commit before:${before} after:${after} count:1`
                        })
                        console.log('searching commits', commitQueries)
                        const commitResults = await queryGraphQL<Record<string, ISearch>>(
                            gql`
                                query BulkSearchCommits(${commitQueries
                                    .map((query, i) => `$query${i}: String!`)
                                    .join(', ')}) {
                                    ${commitQueries
                                        .map(
                                            (query, i) => gql`
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
                            Object.entries(commitResults).map(
                                ([name, result]) => [+name.slice('search'.length), result] as const
                            ),
                            0
                        ).map(([i, search]) => {
                            if (search.results.results.length === 0) {
                                throw new Error(`No result for ${commitQueries[i]}`)
                            }
                            return (search.results.results[0] as ICommitSearchResult).commit.oid
                        })
                        const searchQueries = commitOids.map(
                            oid => `repo:${repoRegexp}@${oid} ${insight.query} count:99999`
                        )
                        console.log('searching', searchQueries)
                        const searchResults = await queryGraphQL<Record<string, ISearch>>(
                            gql`
                                query BulkSearch(${searchQueries.map((query, i) => `$query${i}: String!`).join(', ')}) {
                                    ${searchQueries
                                        .map(
                                            (query, i) => gql`
                                                search${i}: search(version: V2, patternType: literal, query: $query${i}) {
                                                    stats {
                                                        approximateResultCount
                                                    }
                                                }
                                            `
                                        )
                                        .join('\n')}
                                }
                            `,
                            Object.fromEntries(searchQueries.map((query, i) => [`query${i}`, query]))
                        )
                        console.log(searchResults)

                        return {
                            title: insight.title,
                            content: [
                                {
                                    kind: sourcegraph.MarkupKind.Markdown,
                                    value: [
                                        '| Day | Results |',
                                        '|--|--|',
                                        ...sortBy(
                                            Object.entries(searchResults).map(
                                                ([name, result]) => [+name.slice('search'.length), result] as const
                                            ),
                                            0
                                        ).map(([i, result]) => {
                                            console.log({ i, result })
                                            const date = dates[i]
                                            const count = result.stats.approximateResultCount
                                            return `| ${date.toLocaleDateString()} | ${count} |`
                                        }),
                                        '',
                                    ].join('\n'),
                                },
                            ],
                        }
                    },
                })
            )
        })
    )
}

// Sourcegraph extension documentation: https://docs.sourcegraph.com/extensions/authoring
