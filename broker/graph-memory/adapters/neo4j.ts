import { createHash } from 'node:crypto';
import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import type {
  BackendHealth, GraphExpansion, GraphExpansionRequest, GraphProjectionMutation, GraphRepository, JsonValue,
} from './contracts.ts';

export interface Neo4jGraphConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
  connectionTimeoutMs?: number;
  maxTransactionRetryTimeMs?: number;
}

export class GraphRevisionGapError extends Error {
  readonly expected: number;
  readonly received: number;
  constructor(expected: number, received: number) {
    super(`Graph projection revision gap: expected ${expected}, received ${received}`);
    this.expected = expected; this.received = received;
  }
}

function integer(value: unknown): number {
  if (neo4j.isInt(value)) return (value as ReturnType<typeof neo4j.int>).toNumber();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Neo4j returned an unsafe integer');
  return number;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateMutation(mutation: GraphProjectionMutation) {
  for (const [label, value] of Object.entries({ revision: mutation.revision, erasureEpoch: mutation.erasureEpoch, generation: mutation.generation })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  for (const item of [...mutation.nodes, ...mutation.edges]) {
    if (!item.id || item.id.length > 512 || /[\0\r\n]/u.test(item.id)) throw new TypeError('Projection IDs must be nonempty bounded single-line strings');
    if (!/^(?:Memory(?:Entity|Assertion|Evidence|Event|Episode|Topic)|[A-Z][A-Z0-9_]{0,63})$/u.test(item.kind)) throw new TypeError(`Invalid ontology kind ${item.kind}`);
    rejectRawSource(item.properties);
  }
  for (const edge of mutation.edges) if (!edge.from || !edge.to) throw new TypeError('Graph edge endpoints are required');
  for (const id of mutation.deletedIds) if (!id || /[\0\r\n]/u.test(id)) throw new TypeError('Deleted IDs must be nonempty single-line strings');
}

function normalizeMutation(mutation: GraphProjectionMutation): GraphProjectionMutation {
  const unique = <T extends { id: string }>(items: T[], label: string): T[] => {
    const result = new Map<string, T>();
    for (const item of items) {
      const previous = result.get(item.id);
      if (previous && stable(previous) !== stable(item)) throw new TypeError(`Conflicting duplicate ${label} ID ${item.id}`);
      result.set(item.id, item);
    }
    return [...result.values()];
  };
  return { ...mutation, nodes: unique(mutation.nodes, 'node'), edges: unique(mutation.edges, 'edge'), deletedIds: [...new Set(mutation.deletedIds)] };
}

const FORBIDDEN_SOURCE_KEYS = /^(?:body|content|quote|raw|raw_source|source_text|text)$/iu;
function rejectRawSource(value: JsonValue, key = ''): void {
  if (key && FORBIDDEN_SOURCE_KEYS.test(key)) throw new TypeError(`Raw source field ${key} is forbidden in graph projection work`);
  if (Array.isArray(value)) for (const item of value) rejectRawSource(item);
  else if (value && typeof value === 'object') for (const [childKey, item] of Object.entries(value)) rejectRawSource(item, childKey);
}

const NODE_UPSERT = `
UNWIND $rows AS row
OPTIONAL MATCH (tombstone:MemoryErasure {id:row.id})
WITH row,tombstone WHERE tombstone IS NULL
MERGE (g:MemoryProjectionGuard {key: toString($generation) + ':node:' + row.id})
ON CREATE SET g.id = row.id, g.kind = 'node', g.generation = $generation,
  g.revision = -1, g.erasure_epoch = -1, g.deleted = false
WITH g, row WHERE g.erasure_epoch < $erasureEpoch OR
  (g.erasure_epoch = $erasureEpoch AND g.revision < $revision)
SET g.revision = $revision, g.erasure_epoch = $erasureEpoch, g.deleted = false, g.generation = $generation
MERGE (n:MemoryNode {key: toString($generation) + ':' + row.id})
SET n.kind = row.kind, n.properties_json = row.propertiesJson, n.scope_id = row.scopeId,
    n.id = row.id, n.revision = $revision, n.erasure_epoch = $erasureEpoch, n.generation = $generation, n.deleted = false
RETURN count(n) AS count`;

const EDGE_UPSERT = `
UNWIND $rows AS row
MERGE (g:MemoryProjectionGuard {key: toString($generation) + ':edge:' + row.id})
ON CREATE SET g.id = row.id, g.kind = 'edge', g.generation = $generation,
  g.revision = -1, g.erasure_epoch = -1, g.deleted = false
WITH g, row WHERE g.erasure_epoch < $erasureEpoch OR
  (g.erasure_epoch = $erasureEpoch AND g.revision < $revision)
SET g.revision = $revision, g.erasure_epoch = $erasureEpoch, g.deleted = false, g.generation = $generation
WITH row
MATCH (source:MemoryNode {key: toString($generation) + ':' + row.from, deleted: false})
MATCH (target:MemoryNode {key: toString($generation) + ':' + row.to, deleted: false})
MERGE (source)-[edge:MEMORY_LINK {id: row.id}]->(target)
SET edge.kind = row.kind, edge.properties_json = row.propertiesJson, edge.scope_id = row.scopeId,
    edge.revision = $revision, edge.erasure_epoch = $erasureEpoch, edge.generation = $generation, edge.deleted = false
RETURN count(edge) AS count`;

const TOMBSTONE = `
UNWIND $ids AS id
MERGE (ng:MemoryProjectionGuard {key: toString($generation) + ':node:' + id})
ON CREATE SET ng.id = id, ng.kind = 'node', ng.generation = $generation,
  ng.revision = -1, ng.erasure_epoch = -1, ng.deleted = false
WITH id, ng
FOREACH (_ IN CASE WHEN ng.erasure_epoch < $erasureEpoch OR (ng.erasure_epoch = $erasureEpoch AND ng.revision < $revision) THEN [1] ELSE [] END |
  SET ng.revision = $revision, ng.erasure_epoch = $erasureEpoch, ng.generation = $generation, ng.deleted = true)
WITH id
OPTIONAL MATCH (node:MemoryNode {key: toString($generation) + ':' + id})
FOREACH (_ IN CASE WHEN node IS NOT NULL AND (node.erasure_epoch < $erasureEpoch OR (node.erasure_epoch = $erasureEpoch AND node.revision < $revision)) THEN [1] ELSE [] END |
  SET node.properties_json = '{}', node.deleted = true, node.revision = $revision, node.erasure_epoch = $erasureEpoch, node.generation = $generation)
WITH DISTINCT id
MERGE (eg:MemoryProjectionGuard {key: toString($generation) + ':edge:' + id})
ON CREATE SET eg.id = id, eg.kind = 'edge', eg.generation = $generation,
  eg.revision = -1, eg.erasure_epoch = -1, eg.deleted = false
WITH id, eg
FOREACH (_ IN CASE WHEN eg.erasure_epoch < $erasureEpoch OR (eg.erasure_epoch = $erasureEpoch AND eg.revision < $revision) THEN [1] ELSE [] END |
  SET eg.revision = $revision, eg.erasure_epoch = $erasureEpoch, eg.generation = $generation, eg.deleted = true)
WITH id
OPTIONAL MATCH ()-[edge:MEMORY_LINK {id: id, generation: $generation}]->()
DELETE edge`;

export class Neo4jGraphRepository implements GraphRepository {
  readonly config: Neo4jGraphConfig;
  readonly driver: Driver;
  readonly database: string;
  private ownsDriver: boolean;

  constructor(config: Neo4jGraphConfig, driver?: Driver) {
    this.config = config;
    this.database = config.database ?? 'neo4j';
    this.ownsDriver = !driver;
    this.driver = driver ?? neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
      connectionTimeout: config.connectionTimeoutMs ?? 5_000,
      maxTransactionRetryTime: config.maxTransactionRetryTimeMs ?? 15_000,
    });
  }

  async initialize(): Promise<void> {
    await this.driver.verifyConnectivity();
    const statements = [
      'DROP CONSTRAINT memory_node_id IF EXISTS',
      'DROP CONSTRAINT memory_projection_guard_id IF EXISTS',
      "MATCH (n:MemoryNode) WHERE n.key IS NULL SET n.key = toString(n.generation) + ':' + n.id",
      "MATCH (g:MemoryProjectionGuard) WHERE g.key IS NULL SET g.key = toString(g.generation) + ':' + g.id",
      'CREATE CONSTRAINT memory_node_key IF NOT EXISTS FOR (n:MemoryNode) REQUIRE n.key IS UNIQUE',
      'CREATE CONSTRAINT memory_erasure_id IF NOT EXISTS FOR (n:MemoryErasure) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT memory_projection_guard_key IF NOT EXISTS FOR (n:MemoryProjectionGuard) REQUIRE n.key IS UNIQUE',
      'CREATE CONSTRAINT memory_projection_state_generation IF NOT EXISTS FOR (n:MemoryProjectionState) REQUIRE n.generation IS UNIQUE',
      'CREATE INDEX memory_node_scope IF NOT EXISTS FOR (n:MemoryNode) ON (n.scope_id)',
      'CREATE INDEX memory_node_generation IF NOT EXISTS FOR (n:MemoryNode) ON (n.generation)',
    ];
    const session = this.driver.session({ database: this.database });
    try { for (const statement of statements) await session.run(statement); }
    finally { await session.close(); }
  }

  async apply(mutation: GraphProjectionMutation): Promise<'applied' | 'duplicate'> {
    mutation = normalizeMutation(mutation);
    validateMutation(mutation);
    const digest = createHash('sha256').update(stable(mutation)).digest('hex');
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.WRITE });
    try {
      return await session.executeWrite(async transaction => this.applyInTransaction(transaction, mutation, digest));
    } finally { await session.close(); }
  }

  private async applyInTransaction(transaction: ManagedTransaction, mutation: GraphProjectionMutation, digest: string): Promise<'applied' | 'duplicate'> {
    const stateResult = await transaction.run(`
      MERGE (s:MemoryProjectionState {generation: $generation})
      ON CREATE SET s.watermark = $revision - 1, s.erasure_epoch = 0, s.digest = ''
      RETURN s.watermark AS watermark, s.digest AS digest`, { generation: neo4j.int(mutation.generation), revision: neo4j.int(mutation.revision) });
    const state = stateResult.records[0];
    const watermark = integer(state.get('watermark'));
    // Canonical projection data is reconstructed at retry time. A crash after remote success can therefore
    // replay the same revision with newer canonical fields. The already committed backend revision wins;
    // subsequent correction/erasure revisions carry those changes without poisoning the ordered publisher.
    if (mutation.revision <= watermark) return 'duplicate';
    if (mutation.revision !== watermark + 1) throw new GraphRevisionGapError(watermark + 1, mutation.revision);
    const parameters = {
      revision: neo4j.int(mutation.revision), erasureEpoch: neo4j.int(mutation.erasureEpoch), generation: neo4j.int(mutation.generation),
    };
    if (mutation.deletedIds.length) await transaction.run(TOMBSTONE, { ...parameters, ids: mutation.deletedIds });
    if (mutation.nodes.length) await transaction.run(NODE_UPSERT, { ...parameters, rows: mutation.nodes.map(node => ({
      id: node.id, kind: node.kind, propertiesJson: stable(node.properties), scopeId: typeof node.properties.scopeId === 'string' ? node.properties.scopeId : typeof node.properties.scope_id === 'string' ? node.properties.scope_id : '',
    })) });
    if (mutation.edges.length) {
      const result = await transaction.run(EDGE_UPSERT, { ...parameters, rows: mutation.edges.map(edge => ({
        id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, propertiesJson: stable(edge.properties), scopeId: typeof edge.properties.scopeId === 'string' ? edge.properties.scopeId : typeof edge.properties.scope_id === 'string' ? edge.properties.scope_id : '',
      })) });
      if (integer(result.records[0]?.get('count') ?? 0) !== mutation.edges.length) throw new Error('Graph projection edge references a missing or deleted endpoint');
    }
    await transaction.run(`MATCH (s:MemoryProjectionState {generation: $generation})
      SET s.watermark = $revision, s.erasure_epoch = $erasureEpoch, s.digest = $digest`, { ...parameters, digest });
    return 'applied';
  }

  async watermark(generation: number): Promise<number> {
    const result = await this.driver.executeQuery(
      'MATCH (s:MemoryProjectionState {generation: $generation}) RETURN s.watermark AS watermark',
      { generation: neo4j.int(generation) }, { database: this.database, routing: neo4j.routing.READ },
    );
    return result.records.length ? integer(result.records[0].get('watermark')) : 0;
  }

  /** Publication is serialized by Cere; this fence scrubs active and retired generations. */
  async eraseAllGenerations(ids: string[], erasureEpoch: number): Promise<void> {
    if(!ids.length)return;
    const session=this.driver.session({database:this.database});
    try {await session.executeWrite(async tx=>{
      await tx.run('UNWIND $ids AS id MERGE (t:MemoryErasure {id:id}) SET t.epoch=$epoch', {ids,epoch:neo4j.int(erasureEpoch)});
      await tx.run('MATCH (n:MemoryNode) WHERE n.id IN $ids OPTIONAL MATCH (n)-[r:MEMORY_LINK]-() DELETE r SET n.properties_json=\'{}\', n.deleted=true, n.erasure_epoch=$epoch', {ids,epoch:neo4j.int(erasureEpoch)});
      await tx.run('MATCH ()-[r:MEMORY_LINK]->() WHERE r.id IN $ids DELETE r', {ids});
      await tx.run('MATCH (g:MemoryProjectionGuard) WHERE g.id IN $ids SET g.deleted=true,g.erasure_epoch=$epoch', {ids,epoch:neo4j.int(erasureEpoch)});
    });}finally{await session.close();}
  }

  async expand(request: GraphExpansionRequest): Promise<GraphExpansion> {
    request.deadline?.throwIfAborted();
    const depth=Math.min(3,Math.max(1,request.depth??2)),nodeLimit=Math.min(200,request.nodeLimit??200),edgeLimit=Math.min(500,request.edgeLimit??500);
    const nodes=new Map<string,GraphExpansion['nodes'][number]>(),edges=new Map<string,GraphExpansion['edges'][number]>();
    let frontier=[...new Set(request.seedIds)].slice(0,120),truncated=false;
    for(let hop=0;hop<depth&&frontier.length;hop++){
      request.deadline?.throwIfAborted();
      const response=await this.driver.executeQuery(`
        UNWIND $seeds AS seedId
        MATCH (seed:MemoryNode {key:toString($generation) + ':' + seedId,deleted:false})
        WHERE seed.scope_id IN $scopes
        CALL (seed) {
          MATCH (seed)-[rel:MEMORY_LINK]-(node:MemoryNode)
          WHERE node.generation=$generation AND node.deleted=false AND node.scope_id IN $scopes
            AND rel.generation=$generation AND rel.deleted=false AND rel.scope_id IN $scopes
          RETURN rel,node ORDER BY rel.id LIMIT 20
        }
        RETURN seed,rel,node LIMIT $limit`,
        {seeds:frontier,generation:neo4j.int(request.generation),scopes:request.scopeIds,limit:neo4j.int(Math.max(1,edgeLimit-edges.size))},
        {database:this.database,routing:neo4j.routing.READ,transactionConfig:{timeout:500}});
      const next:string[]=[];
      for(const row of response.records){
        const seed=row.get('seed'),node=row.get('node'),rel=row.get('rel');
        for(const item of [seed,node])if(!nodes.has(String(item.properties.id))){if(nodes.size>=nodeLimit){truncated=true;continue;}nodes.set(String(item.properties.id),{id:String(item.properties.id),kind:String(item.properties.kind),properties:JSON.parse(String(item.properties.properties_json))});next.push(String(item.properties.id));}
        if(nodes.has(String(seed.properties.id))&&nodes.has(String(node.properties.id))&&edges.size<edgeLimit)edges.set(String(rel.properties.id),{id:String(rel.properties.id),from:String(seed.properties.id),to:String(node.properties.id),kind:String(rel.properties.kind),properties:JSON.parse(String(rel.properties.properties_json))});
      }
      if(nodes.size>=nodeLimit||edges.size>=edgeLimit){truncated=true;break;}frontier=next;
    }
    request.deadline?.throwIfAborted();
    return {nodes:[...nodes.values()],edges:[...edges.values()],truncated};
  }

  async health(): Promise<BackendHealth> {
    try {
      const info = await this.driver.getServerInfo();
      return { ok: true, detail: 'connected', version: info.agent };
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'connection failed' }; }
  }

  async close(): Promise<void> { if (this.ownsDriver) await this.driver.close(); }
}
