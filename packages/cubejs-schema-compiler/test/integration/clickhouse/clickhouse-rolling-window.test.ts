import { prepareYamlCompiler } from '../../unit/PrepareCompiler';
import { ClickHouseQuery } from '../../../src/adapter/ClickHouseQuery';
import { ClickHouseDbRunner } from './ClickHouseDbRunner';

// Runs on both planners, CUBEJS_TESSERACT_SQL_PLANNER chooses one. On the legacy planner the time
// series comes from ClickHouseQuery.seriesSql, and on Tesseract from statements.time_series_select.
describe('ClickHouse rolling window by buckets', () => {
  jest.setTimeout(200000);

  const dbRunner = new ClickHouseDbRunner();

  const noDataSet = async () => Promise.resolve();

  afterAll(async () => {
    await dbRunner.tearDown();
  });

  const row = (id: number, amount: string, at: string) => `SELECT ${id} AS id, ${amount} AS amount, toDateTime('${at}', 'UTC') AS created_at`;

  const compilers = prepareYamlCompiler(`
cubes:
  - name: orders
    sql: >
      ${row(1, 'toNullable(1)', '2025-03-20 00:00:00')}
      UNION ALL ${row(2, 'toNullable(10)', '2025-04-15 00:00:00')}
      UNION ALL ${row(3, 'toNullable(100)', '2025-04-20 00:00:00')}
      UNION ALL ${row(4, 'toNullable(1000)', '2025-05-10 00:00:00')}
      UNION ALL ${row(5, 'NULL', '2025-05-11 00:00:00')}
    dimensions:
      - name: id
        sql: "{CUBE}.id"
        type: number
        primary_key: true
      - name: created_at
        sql: "{CUBE}.created_at"
        type: time
    measures:
      - name: revenue_30d
        sql: "{CUBE}.amount"
        type: sum
        rolling_window:
          trailing: 30 day
      - name: revenue_100y
        sql: "{CUBE}.amount"
        type: sum
        rolling_window:
          trailing: 100 year
      - name: count_1d
        type: count
        rolling_window:
          trailing: 1 day
`);

  beforeAll(async () => {
    await compilers.compile();
  });

  it.each([
    ['one bucket', 'month', ['2025-04-01', '2025-04-30'], [['2025-04-01T00:00:00.000', '2025-04-30T23:59:59.000']]],
    ['two buckets', 'month', ['2025-04-01', '2025-05-31'], [['2025-04-01T00:00:00.000', '2025-04-30T23:59:59.000'], ['2025-05-01T00:00:00.000', '2025-05-31T23:59:59.000']]],
    ['three buckets', 'day', ['2025-04-30', '2025-05-02'], [['2025-04-30T00:00:00.000', '2025-04-30T23:59:59.000'], ['2025-05-01T00:00:00.000', '2025-05-01T23:59:59.000'], ['2025-05-02T00:00:00.000', '2025-05-02T23:59:59.000']]],
  ])('pairs the bounds of %s in seriesSql', async (_name, granularity, dateRange, expected) => {
    const query = new ClickHouseQuery(compilers, {
      measures: ['orders.revenue_30d'],
      timeDimensions: [{ dimension: 'orders.created_at', granularity, dateRange }],
      timezone: 'UTC',
    });
    const rows = await dbRunner.testQuery(
      [`SELECT date_from, date_to FROM (${query.seriesSql(query.timeDimensions[0])}) ORDER BY date_from, date_to`, []],
      noDataSet
    );

    expect(rows.map((r: any) => [r.date_from, r.date_to])).toEqual(expected);
  });

  // Before 24.5 ClickHouse has no inequality in JOIN ON, and a rolling window needs one
  const itWithInequalityJoin = (process.env.TEST_CLICKHOUSE_VERSION || '23.11') >= '24.5' ? it : it.skip;

  itWithInequalityJoin.each([
    ['30 days, by month', 'revenue_30d', 'month', ['2025-04-01', '2025-05-31'], [['2025-04-01T00:00:00.000', '110'], ['2025-05-01T00:00:00.000', '1000']]],
    ['a far bound, by month', 'revenue_100y', 'month', ['2025-04-01', '2025-05-31'], [['2025-04-01T00:00:00.000', '111'], ['2025-05-01T00:00:00.000', '1111']]],
    ['a single bucket', 'revenue_30d', 'month', ['2025-04-01', '2025-04-30'], [['2025-04-01T00:00:00.000', '110']]],
    ['a bucket with no rows', 'revenue_30d', 'month', ['2025-07-01', '2025-08-31'], [['2025-07-01T00:00:00.000', null], ['2025-08-01T00:00:00.000', null]]],
    ['a count with a NULL value, by day', 'count_1d', 'day', ['2025-05-10', '2025-05-12'], [['2025-05-10T00:00:00.000', '1'], ['2025-05-11T00:00:00.000', '1'], ['2025-05-12T00:00:00.000', null]]],
  ])('%s', async (_name, measure, granularity, dateRange, expected) => {
    const query = new ClickHouseQuery(compilers, {
      measures: [`orders.${measure}`],
      timeDimensions: [{ dimension: 'orders.created_at', granularity, dateRange }],
      order: [{ id: 'orders.created_at' }],
      timezone: 'UTC',
    });
    const rows = await dbRunner.testQuery(query.buildSqlAndParams(), noDataSet);

    expect(rows.map((r: any) => [r[`orders__created_at_${granularity}`], r[`orders__${measure}`]])).toEqual(expected);
  });
});
