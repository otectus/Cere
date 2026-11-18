// A temporary SQLite profile still uses the broker's default projection endpoints.
// Fixture tests that exercise a projection supply their own local server.
delete process.env.CERE_MEMORY_CREDENTIALS_FILE;
delete process.env.CERE_NEO4J_PASSWORD;
delete process.env.CERE_QDRANT_API_KEY;
process.env.CERE_NEO4J_URI = 'bolt://127.0.0.1:9';
process.env.CERE_QDRANT_URL = 'http://127.0.0.1:9';
