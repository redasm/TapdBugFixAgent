# 在 config.yaml 中接入项目测试

所有 Agent 接入配置都放在本工具的 `config.yaml`，位于 `workspaces[].repos[]` 下。系统不会向目标仓库添加 Agent 配置，不要求创建名为 `behavior-suites` 或 `tests` 的目录。测试目录、原生执行命令由用户指定，已有测试工程可直接复用。

## 优先使用项目已有测试

例如项目根目录为 `D:/Product`，测试工程位于 `D:/Product/tests`，并已有自己的 `package.json`：

```yaml
workspaces:
  - workspace_id: "项目ID"
    owner: "负责人"
    default_repo: product
    repos:
      - name: product
        path: D:/Product
        verify_cmds:
          - command: npm run typecheck
            cwd: .
            timeout_sec: 600
          - command: npm test -- --run
            cwd: tests
            timeout_sec: 600
```

`cwd` 相对所属 `repo.path`，也可以填用户指定的绝对路径，例如 `D:/QA/ProductTests`。名称可以是 `tests`、`qa`、`test-project` 等。附加 Git 目录的 `verify_cmds` 用法相同，相对路径从该 Git 目录计算。独立测试工程需自行引用当前待修复源码，避免测试了另一个工作区。

命令按项目框架填写，不根据目录名猜测：

| 已有测试工程 | command 示例 | cwd 示例 |
|---|---|---|
| Vitest，package.json 在项目根目录 | `npm test -- --run tests` | `.` |
| Jest，package.json 在项目根目录 | `npm test -- --runInBand tests` | `.` |
| 独立 Node 测试工程 | `npm test -- --run`（按其 npm script 调整参数） | `tests` |
| pytest | `python -m pytest tests` | `.` |
| .NET 测试项目 | `dotnet test tests/Product.Tests.csproj` | `.` |
| 外部测试工程 | 该工程已有的一次性测试命令 | `D:/QA/ProductTests` |

使用一次运行后退出的命令，避免 watch 模式。依赖和测试环境需已准备好；Agent 不会为接入自动运行 `npm init`、生成配置或改写测试。测试工具自身可能生成报告或缓存。

只需在仓库根运行命令时可简写 `verify_cmds: ["npm test -- --run"]`。对象形式可配置 `command`、`cwd`、`timeout_sec`；默认超时600秒，范围1–7200秒。配置加载时检查执行目录，验证阶段顺序运行，首个失败阻止交付。审计保留命令、实际执行目录、超时与结果。修改配置后需重启服务。

这些命令在修复后执行，属于构建/测试通过证据。不会根据命令名称推断覆盖率，也不会把一个退出码自动解释为“本 Bug 修复前失败、修复后通过”。

## 可选的专项行为验证

如需逐条记录冻结断言的修复前后结果，可额外接入本工具协议的 `.mjs` 脚本目录：

```yaml
behavior_checks:
  enabled: true
  directory: D:/QA/ProductBehavior
  disabled: []
  timeout_sec: 30
```

`directory` 支持用户指定的绝对路径、相对 `config.yaml` 的路径，以及显式仓库根占位符，例如 `'{repo}/qa/agent-suites'`。没有默认扫描的目标测试目录；不配置或设置 `enabled: false` 即不启用。用户选好目录后，系统只读取其中的专项脚本。

普通 Jest、pytest、dotnet 测试目录直接使用前面的 `verify_cmds`，不需要声明 `export const files`。`behavior_checks` 只发现本工具协议的脚本，两者可同时使用。专项脚本新增/删除及临时停用方法见 [维护指南](../behavior-suites/README.md)。
