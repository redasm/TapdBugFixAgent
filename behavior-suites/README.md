# 行为测试的增删与维护

每个 `.mjs` 文件是一套测试。每次修复进入实施前，系统重新扫描配置目录及子目录，只执行适用源码与 `planned_files` 有交集的测试。目录为空或没有匹配测试时，保留 L0 和人工验收提示。

## 配置

在对应仓库的 `behavior_checks` 下配置：

```yaml
behavior_checks:
  enabled: true
  directory: behavior-suites
  disabled: []
  timeout_sec: 30
```

`directory` 相对 `config.yaml` 所在目录，也支持绝对路径。每个项目应使用自己的专用测试目录。内置三套测试针对 project 客户端。脚本须放在修复 Agent 修改范围之外，按受信任验证代码维护。

- **新增**：放入符合下面协议的 `.mjs`，下次修复自动发现，不需要修改配置或重启。
- **删除**：删除 `.mjs`，下次修复不再使用；正在执行的修复继续使用其已冻结的版本。
- **临时停用**：如 `disabled: [map-tiles]`；恢复时从列表移除。测试名是目录内的相对路径去掉 `.mjs`，如 `map/tiles.mjs` 的名称为 `map/tiles`。
- **全部停用**：设置 `enabled: false`。修改启停、目录或超时配置后需重启服务。
- **源码移动**：只修改脚本中的 `files`；测试体使用 `files[0]` 等引用，不重复写路径。

扫描忽略隐藏项、`node_modules` 和符号链接。不支持 glob；一套测试可声明多个具体源码文件。默认每套30秒，可配置1–300秒。单脚本不超过100KB；专用测试目录最多2000项。无效的活动脚本元数据会中止准备阶段，错误中含测试名；停用项不解析。

## 脚本协议

脚本必须直接导出 `const files`，值为非空字符串字面量数组，每个路径相对目标 `repo.path`。扫描使用静态语法解析，不导入脚本；不要通过函数、变量拼接或动态导出构造 `files`。

例如目标源码有 `Inventory.canAdd(current, amount, capacity)`，可编写 `inventory-capacity.mjs`：

```js
export const files = ['TypeScript/Src/Game/Inventory.ts'];

export default async ({ test, assert, loadMembers }) => {
  const inventory = loadMembers(files[0], 'Inventory', ['canAdd'], {});
  await test('reject-over-capacity', 'reproduction', () => {
    assert.equal(inventory.canAdd(9, 2, 10), false);
  });
  await test('accept-within-capacity', 'regression', () => {
    assert.equal(inventory.canAdd(8, 1, 10), true);
  });
};
```

请按实际源码的类名、成员、依赖和业务需求编写断言。`loadMembers` 执行从实际 TypeScript 源码提取的成员；第四个参数提供依赖替身，不会初始化完整 UE 环境。`reproduction` 检查目标错误，`regression` 检查应保持的正常行为。每个 test 的 ID 必须唯一。本地相对 import 不受支持。

元数据与脚本内容在修改前一起冻结；修改后重跑同一份脚本。只有目标断言修复前失败、修复后通过，所有测试通过，且存在前后均通过的正常对照时才报告 L1。当前代码本来通过的测试只提供回归证据，不表示新 Bug 已复现。
