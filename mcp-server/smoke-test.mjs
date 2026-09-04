import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  env: { ...process.env, DEXTER_PROJECT_ID: 'smoketest' }
});

const client = new Client({ name: 'smoke-test-client', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map(t => t.name).join(', '));

const dossierBefore = await client.callTool({ name: 'dexter_get_dossier', arguments: {} });
console.log('DOSSIER BEFORE:', JSON.stringify(dossierBefore.content));

const addResult = await client.callTool({ name: 'dexter_add_agent_task', arguments: { title: 'Smoke test task', lane: 'attention', setback_reason: 'testing' } });
console.log('ADD RESULT:', JSON.stringify(addResult.content), JSON.stringify(addResult.structuredContent));

const appendResult = await client.callTool({ name: 'dexter_append_dossier', arguments: { entry: 'Smoke test dossier entry.' } });
console.log('APPEND RESULT:', JSON.stringify(appendResult.content));

const logResult = await client.callTool({ name: 'dexter_log_activity', arguments: { text: 'Smoke test activity' } });
console.log('LOG RESULT:', JSON.stringify(logResult.content));

const tasksAfter = await client.callTool({ name: 'dexter_get_agent_tasks', arguments: {} });
console.log('TASKS AFTER:', JSON.stringify(tasksAfter.structuredContent));

const dossierAfter = await client.callTool({ name: 'dexter_get_dossier', arguments: {} });
console.log('DOSSIER AFTER:', JSON.stringify(dossierAfter.content));

await client.close();
process.exit(0);
