import { TapdMcpClient } from './dist/tapdMcp.js';
const cfg = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@xihe-lab/tapd-mcp-server'],
  tool_map: {
    list_bugs: 'tapd_get_bugs',
    get_bug: 'tapd_get_bugs',
    update_bug: 'tapd_update_bug',
    add_comment: 'tapd_create_comment',
  },
};
const c = new TapdMcpClient('52729922', cfg);
try {
  await c.connect();
  console.log(await c.dumpTools());
  console.log('===== getBug =====');
  const bug = await c.getBug('1152729922001254607');
  console.log(JSON.stringify(bug, null, 2));
} catch (e) {
  console.error('ERR', e);
}
