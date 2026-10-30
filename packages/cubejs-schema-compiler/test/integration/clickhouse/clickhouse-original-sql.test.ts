import { prepareYamlCompiler } from '../../unit/PrepareCompiler';
import { ClickHouseQuery } from '../../../src/adapter/ClickHouseQuery';
import { ClickHouseDbRunner } from './ClickHouseDbRunner';

describe('ClickHouse original_sql pre-aggregation with no index', () => {
  jest.setTimeout(200000);

  const dbRunner = new ClickHouseDbRunner();

  afterAll(async () => {
    await dbRunner.tearDown();
  });

  const compilers = prepareYamlCompiler(`
cubes:
  - name: orders
    sql: >
      SELECT 1 AS id, 'a' AS status, toNullable(10) AS amount, toDateTime('2025-01-01 00:00:00', 'UTC') AS created_at
      UNION ALL
      SELECT 2 AS id, 'b' AS status, NULL AS amount, toDateTime('2025-01-02 00:00:00', 'UTC') AS created_at
    pre_aggregations:
      - name: base
        type: original_sql
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: status
        sql: status
        type: string
      - name: created_at
        sql: created_at
        type: time
    measures:
      - name: revenue
        sql: amount
        type: sum

  - name: indexed_orders
    sql: "SELECT 1 AS id, 'a' AS status"
    pre_aggregations:
      - name: rollup_no_index
        dimensions:
          - status
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: status
        sql: status
        type: string
`);

  beforeAll(async () => {
    await compilers.compile();
  });

  const loadSql = (cube: string, name: string, tableName: string): [string, unknown[]] => {
    const preAggregation = compilers.cubeEvaluator.preAggregationsForCube(cube)[name];
    const query = compilers.createQuery(ClickHouseQuery, { timezone: 'UTC' }) as ClickHouseQuery;
    const sqlEvaluationQuery = query.preAggregationQueryForSqlEvaluation(cube, preAggregation) as ClickHouseQuery;
    return sqlEvaluationQuery.preAggregationLoadSql(cube, preAggregation, tableName) as [string, unknown[]];
  };

  it('builds a table with the columns of the cube SQL', async () => {
    const tableName = `original_sql_test_${process.pid}`;
    const [sql] = loadSql('orders', 'base', tableName);

    try {
      const rows = await dbRunner.testQuery(
        [`SELECT id, status, amount, created_at FROM ${tableName} ORDER BY id`, []],
        async (clickHouse) => {
          await clickHouse.command({ query: sql });
        }
      );
      expect(rows).toEqual([
        { id: '1', status: 'a', amount: '10', created_at: '2025-01-01T00:00:00.000' },
        { id: '2', status: 'b', amount: null, created_at: '2025-01-02T00:00:00.000' },
      ]);
    } finally {
      await dbRunner.testQuery(['SELECT 1', []], async (clickHouse) => {
        await clickHouse.command({ query: `DROP TABLE IF EXISTS ${tableName}` });
      });
    }
  });

  it('still refuses a rollup with no index', () => {
    expect(() => loadSql('indexed_orders', 'rollup_no_index', 'unused')).toThrow(
      'ClickHouse doesn\'t support pre-aggregations without indexes'
    );
  });
});
