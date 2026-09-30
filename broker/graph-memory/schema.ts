export const schema = `
CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_us INTEGER NOT NULL) STRICT;
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE scopes(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('user','project','task')),parent_id TEXT REFERENCES scopes(id),external_key TEXT UNIQUE,label TEXT NOT NULL,revision INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE sources(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),kind TEXT NOT NULL,external_identity TEXT NOT NULL,trust TEXT NOT NULL,epoch TEXT NOT NULL,policy_epoch INTEGER NOT NULL,UNIQUE(scope_id,kind,external_identity)) STRICT;
CREATE TABLE payloads(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),body TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL,sensitivity TEXT NOT NULL,retention TEXT NOT NULL,expires_us INTEGER,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE observations(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),source_id TEXT NOT NULL REFERENCES sources(id),source_epoch TEXT NOT NULL,source_sequence INTEGER NOT NULL,source_event_id TEXT NOT NULL,occurred_us INTEGER NOT NULL,captured_us INTEGER NOT NULL,payload_id TEXT REFERENCES payloads(id),role TEXT NOT NULL,storage_mode TEXT NOT NULL CHECK(storage_mode IN ('durable','transient')),extraction_state TEXT NOT NULL,revision INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0,UNIQUE(source_id,source_epoch,source_event_id)) STRICT;
CREATE TABLE entities(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),type TEXT NOT NULL,name TEXT NOT NULL,external_id TEXT,identity_revision INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE entity_aliases(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES entities(id),scope_id TEXT NOT NULL REFERENCES scopes(id),kind TEXT NOT NULL,normalized TEXT NOT NULL,valid_from_us INTEGER,valid_to_us INTEGER,revision INTEGER NOT NULL) STRICT;
CREATE INDEX alias_lookup ON entity_aliases(scope_id,kind,normalized);
CREATE INDEX entity_scope ON entities(scope_id,type,external_id);
CREATE TABLE identity_links(id TEXT PRIMARY KEY,left_id TEXT NOT NULL REFERENCES entities(id),right_id TEXT NOT NULL REFERENCES entities(id),decision TEXT NOT NULL CHECK(decision IN ('possible','same','not_same')),evidence_id TEXT NOT NULL REFERENCES evidence(id),revision INTEGER NOT NULL,reverted_revision INTEGER) STRICT;
CREATE TABLE fact_slots(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),subject_id TEXT NOT NULL REFERENCES entities(id),predicate TEXT NOT NULL,qualifiers TEXT NOT NULL,cardinality TEXT NOT NULL CHECK(cardinality IN ('single','multiple')),aggregate_revision INTEGER NOT NULL,UNIQUE(scope_id,subject_id,predicate,qualifiers)) STRICT;
CREATE TABLE extraction_runs(id TEXT PRIMARY KEY,observation_id TEXT NOT NULL REFERENCES observations(id),model_identity TEXT NOT NULL,prompt_version TEXT NOT NULL,parser_version TEXT NOT NULL,schema_version INTEGER NOT NULL,status TEXT NOT NULL,output_payload_id TEXT REFERENCES payloads(id),attempts INTEGER NOT NULL DEFAULT 0,policy_epoch INTEGER NOT NULL,erasure_epoch INTEGER NOT NULL,revision INTEGER NOT NULL,error_code TEXT) STRICT;
CREATE TABLE assertion_versions(version_id TEXT PRIMARY KEY,logical_id TEXT NOT NULL,slot_id TEXT NOT NULL REFERENCES fact_slots(id),scope_id TEXT NOT NULL REFERENCES scopes(id),subject_id TEXT NOT NULL REFERENCES entities(id),predicate TEXT NOT NULL,object_entity_id TEXT REFERENCES entities(id),value_json TEXT,qualifiers TEXT NOT NULL,polarity TEXT NOT NULL CHECK(polarity IN ('positive','negative')),modality TEXT NOT NULL CHECK(modality IN ('actual','planned','hypothetical','reported','inferred')),epistemic_type TEXT NOT NULL CHECK(epistemic_type IN ('explicit_user','instrumented','document_claim','inference','derived_summary')),status TEXT NOT NULL CHECK(status IN ('candidate','accepted','disputed','rejected','erased')),valid_from_us INTEGER,valid_to_us INTEGER,valid_mode TEXT NOT NULL CHECK(valid_mode IN ('bounded','known_current','atemporal','unknown')),time_precision TEXT NOT NULL,time_zone TEXT NOT NULL,time_expression TEXT NOT NULL,known_from_revision INTEGER NOT NULL,known_to_revision INTEGER,known_from_us INTEGER NOT NULL,known_to_us INTEGER,extraction_run_id TEXT REFERENCES extraction_runs(id),extraction_confidence REAL NOT NULL CHECK(extraction_confidence BETWEEN 0 AND 1),retention_class TEXT NOT NULL,sensitivity TEXT NOT NULL,expires_at_us INTEGER,aggregate_revision INTEGER NOT NULL,erasure_epoch INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0,CHECK((object_entity_id IS NULL)!=(value_json IS NULL)),CHECK(known_to_revision IS NULL OR known_to_revision>known_from_revision),CHECK(valid_to_us IS NULL OR (valid_from_us IS NOT NULL AND valid_to_us>valid_from_us)),CHECK(valid_mode!='bounded' OR valid_from_us IS NOT NULL)) STRICT;
CREATE INDEX assertions_timeline ON assertion_versions(scope_id,slot_id,known_from_revision,known_to_revision,valid_from_us,valid_to_us);
CREATE INDEX assertions_subject ON assertion_versions(scope_id,subject_id,predicate);
CREATE INDEX assertions_object ON assertion_versions(scope_id,object_entity_id,predicate);
CREATE TABLE evidence(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),observation_id TEXT NOT NULL REFERENCES observations(id),source_revision INTEGER NOT NULL,locator TEXT NOT NULL,witness TEXT NOT NULL,digest TEXT NOT NULL,trust TEXT NOT NULL,independence_group TEXT NOT NULL,sensitivity TEXT NOT NULL,revision INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE assertion_evidence(version_id TEXT NOT NULL REFERENCES assertion_versions(version_id),evidence_id TEXT NOT NULL REFERENCES evidence(id),relation TEXT NOT NULL CHECK(relation IN ('support','contradiction')),independence_group TEXT NOT NULL,PRIMARY KEY(version_id,evidence_id,relation)) STRICT;
CREATE TABLE events(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),observation_id TEXT NOT NULL REFERENCES observations(id),task_id TEXT,thread_id TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,occurred_us INTEGER NOT NULL,captured_us INTEGER NOT NULL,stream_sequence INTEGER NOT NULL,payload_id TEXT REFERENCES payloads(id),revision INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE event_edges(id TEXT PRIMARY KEY,from_id TEXT NOT NULL REFERENCES events(id),to_id TEXT NOT NULL REFERENCES events(id),relation TEXT NOT NULL,evidence_id TEXT REFERENCES evidence(id),order_basis TEXT NOT NULL,revision INTEGER NOT NULL) STRICT;
CREATE TABLE tasks(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),binding TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE episodes(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),thread_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','closing','consolidating','archived','retryable')),event_cutoff INTEGER,summary_id TEXT,source_generation INTEGER NOT NULL,revision INTEGER NOT NULL,policy_epoch INTEGER NOT NULL,erasure_epoch INTEGER NOT NULL,previous_id TEXT REFERENCES episodes(id),erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE episode_events(episode_id TEXT NOT NULL REFERENCES episodes(id),event_id TEXT NOT NULL REFERENCES events(id),ordering INTEGER NOT NULL,PRIMARY KEY(episode_id,event_id)) STRICT;
CREATE INDEX episode_membership ON episode_events(event_id,episode_id);
CREATE TABLE topics(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),name TEXT NOT NULL,summary_id TEXT,revision INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE topic_links(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES topics(id),target_id TEXT NOT NULL,kind TEXT NOT NULL,weight REAL NOT NULL CHECK(weight>=0),revision INTEGER NOT NULL) STRICT;
CREATE TABLE artifacts(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),kind TEXT NOT NULL,record_id TEXT NOT NULL,payload_id TEXT NOT NULL REFERENCES payloads(id),source_generation INTEGER NOT NULL,content_revision INTEGER NOT NULL,known_from_revision INTEGER NOT NULL,known_to_revision INTEGER,invalidated INTEGER NOT NULL DEFAULT 0,sensitivity TEXT NOT NULL,expires_us INTEGER,erasure_epoch INTEGER NOT NULL,session_id TEXT NOT NULL DEFAULT '') STRICT;
CREATE INDEX artifacts_scope ON artifacts(scope_id,kind,content_revision,invalidated);
CREATE TABLE retrieval_documents(rowid INTEGER PRIMARY KEY,artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),scope_id TEXT NOT NULL REFERENCES scopes(id),content_revision INTEGER NOT NULL,text TEXT NOT NULL) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(text,content='retrieval_documents',content_rowid='rowid',tokenize='unicode61');
CREATE TRIGGER documents_insert AFTER INSERT ON retrieval_documents BEGIN INSERT INTO memory_fts(rowid,text) VALUES(new.rowid,new.text);END;
CREATE TRIGGER documents_delete AFTER DELETE ON retrieval_documents BEGIN INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',old.rowid,old.text);END;
CREATE TRIGGER documents_update AFTER UPDATE ON retrieval_documents BEGIN INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',old.rowid,old.text);INSERT INTO memory_fts(rowid,text) VALUES(new.rowid,new.text);END;
CREATE TABLE lineage(derived_id TEXT NOT NULL,input_id TEXT NOT NULL,role TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(derived_id,input_id,role),CHECK(derived_id!=input_id)) STRICT;
CREATE INDEX lineage_inputs ON lineage(input_id,derived_id);
CREATE TABLE commits(revision INTEGER PRIMARY KEY AUTOINCREMENT,transaction_us INTEGER NOT NULL,wall_us INTEGER NOT NULL,clock_discontinuity INTEGER NOT NULL,mutation_id TEXT NOT NULL UNIQUE,schema_version INTEGER NOT NULL,delta_payload_id TEXT REFERENCES payloads(id)) STRICT;
CREATE TABLE mutation_effects(revision INTEGER NOT NULL REFERENCES commits(revision),target_id TEXT NOT NULL,operation TEXT NOT NULL,aggregate_version INTEGER NOT NULL,PRIMARY KEY(revision,target_id)) STRICT;
CREATE TABLE outbox(id TEXT PRIMARY KEY,backend TEXT NOT NULL,revision INTEGER NOT NULL REFERENCES commits(revision),generation TEXT NOT NULL,erasure_epoch INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','leased','done','retryable','rejected')),attempts INTEGER NOT NULL DEFAULT 0,next_retry_us INTEGER NOT NULL DEFAULT 0,lease_until_us INTEGER,error_code TEXT,UNIQUE(backend,revision,generation)) STRICT;
CREATE INDEX outbox_pending ON outbox(backend,generation,state,next_retry_us,revision);
CREATE TABLE projection_state(backend TEXT NOT NULL,generation TEXT NOT NULL,watermark INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'pending',error_code TEXT,PRIMARY KEY(backend,generation)) STRICT;
CREATE TABLE projection_records(backend TEXT NOT NULL,generation TEXT NOT NULL,record_id TEXT NOT NULL,revision INTEGER NOT NULL,erasure_epoch INTEGER NOT NULL,PRIMARY KEY(backend,generation,record_id)) STRICT;
CREATE TABLE erasure_jobs(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),epoch INTEGER NOT NULL,state TEXT NOT NULL,canonical_ack INTEGER NOT NULL,graph_ack INTEGER NOT NULL DEFAULT 0,vector_ack INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,reason TEXT NOT NULL) STRICT;
CREATE TABLE tombstones(target_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES erasure_jobs(id),epoch INTEGER NOT NULL,revision INTEGER NOT NULL) STRICT;
CREATE TABLE response_records(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),response_ref TEXT NOT NULL,supplied_evidence_ids TEXT NOT NULL,cited_evidence_ids TEXT NOT NULL,snapshot_revision INTEGER NOT NULL,policy_epoch INTEGER NOT NULL,erasure_epoch INTEGER NOT NULL,erased INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE read_tokens(token TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),revision INTEGER NOT NULL,targets TEXT NOT NULL,policy_epoch INTEGER NOT NULL,erasure_epoch INTEGER NOT NULL) STRICT;
CREATE TABLE embedding_records(artifact_id TEXT NOT NULL REFERENCES artifacts(id),content_revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,generation TEXT NOT NULL,point_id TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(artifact_id,content_revision,fingerprint,generation)) STRICT;
`;
/**
 * Ordered upgrades after the initial schema. Each entry is applied once in its
 * own transaction and verified by checksum on every open, so these texts are
 * immutable once published. Append new migrations; never edit an existing one.
 */
export const migrations: { id: number; sql: string }[] = [
  {
    id: 2,
    sql: `
CREATE TABLE note_revisions(note_id TEXT NOT NULL,observation_id TEXT NOT NULL REFERENCES observations(id),artifact_id TEXT NOT NULL REFERENCES artifacts(id),revision INTEGER NOT NULL,source_role TEXT NOT NULL,PRIMARY KEY(note_id,observation_id)) STRICT;
CREATE INDEX note_revisions_observation ON note_revisions(observation_id);
INSERT OR IGNORE INTO note_revisions(note_id,observation_id,artifact_id,revision,source_role) SELECT a.record_id,e.observation_id,a.id,a.content_revision,o.role FROM artifacts a JOIN lineage l ON l.derived_id=a.id AND l.role='derived' JOIN evidence e ON e.id=l.input_id JOIN observations o ON o.id=e.observation_id WHERE a.kind='saved';
ALTER TABLE episodes ADD COLUMN consolidation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN next_retry_us INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN error_code TEXT;
ALTER TABLE response_records ADD COLUMN evidence_scopes TEXT NOT NULL DEFAULT '{}';
CREATE INDEX extraction_runs_status ON extraction_runs(status,revision);
`,
  },
];
