Provides interactive code insights on Sourcegraph directory pages from configurable code searches.
The insight shows the development of the number of matches over time for a configurable time frame up to now.
Each data point links to a [diff search](https://docs.sourcegraph.com/user/search#commit-diff-search) between that data point and the previous to explain the changes between the two datapoints.

<p>
<picture>
<source srcset="https://user-images.githubusercontent.com/10532611/81548701-f80cb980-937d-11ea-99c6-4ef2d0c0278e.gif" media="(prefers-color-scheme: dark)" />
<source srcset="https://user-images.githubusercontent.com/10532611/81548695-f642f600-937d-11ea-8e22-6f809a861b5d.gif" media="(prefers-color-scheme: light)" />
<img src="https://user-images.githubusercontent.com/10532611/81548701-f80cb980-937d-11ea-99c6-4ef2d0c0278e.gif" alt="Screenshot" />
</picture>
</p>

## Configuration

To add a search insight, add an object like this to your user, organization or global settings:

```jsonc
// Choose any name - only the prefix "searchInsights.insight." is mandatory.
"searchInsights.insight.reactFunctionComponentMigration": {
  // Shown as the title of the insight.
  "title": "Migration to React function components",
  // The lines of the chart.
  "series": [
    {
      // Name shown in the legend and tooltip.
      "name": "Function components",
      // The search query that will be run for the interval defined in "step".
      // Do not include the "repo:" filter as it will be added automatically for the current repsitory.
      "query": "patternType:regexp const\\s\\w+:\\s(React\\.)?FunctionComponent",
      // An optional color for the line.
      // Can be any hex color code, rgb(), hsl(),
      // or reference color variables from the OpenColor palette (recommended): https://yeun.github.io/open-color/
      // The semantic colors var(--danger), var(--warning) and var(--info) are also available.
      "stroke": "var(--oc-teal-7)"
    },
    {
      "name": "Class components",
      "query": "patternType:regexp extends\\s(React\\.)?(Pure)?Component",
      "stroke": "var(--oc-indigo-7)"
    }
  ],
  // The step between two data points. Supports days, months, hours, etc.
  "step": {
    "weeks": 2
  }
}
```

Multiple search insights can be defined by adding more objects under different keys, as long as they are prefixed with `searchInsights.insight.`.
