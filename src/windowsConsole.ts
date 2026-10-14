/**
 * Windows 控制台「快速编辑模式」防冻结。
 *
 * 快速编辑模式下，在控制台窗口里点一下就会进入「选择」状态（标题以「选择」开头），此时
 * 任何写控制台的调用都会阻塞——整个 Node 进程随之冻结：HTTP 不响应、不报错、不占 CPU，
 * 直到有人在窗口里按 Esc/回车。serve 每一步都会打日志，因此极易中招。
 *
 * Node 没有改控制台模式的 API：这里启动一个共享同一控制台的 PowerShell 子进程，打开
 * CONIN$ 后清掉 ENABLE_QUICK_EDIT_MODE。只影响当前这个控制台窗口会话，不改注册表/默认设置。
 */
import { spawn } from "node:child_process";

const DISABLE_QUICK_EDIT_PS = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { 'failed'; exit }
$sig = '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode);'
$k = Add-Type -MemberDefinition $sig -Name ConsoleMode -Namespace TapdAgent -PassThru
# GENERIC_READ | GENERIC_WRITE；PowerShell 5.1 会把字面量 0xC0000000 解析成负的 Int32，必须写成 uint32
$h = $k::CreateFile('CONIN$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$mode = [uint32]0
if (-not $k::GetConsoleMode($h, [ref]$mode)) { 'no-console'; exit }
if (($mode -band 0x40) -eq 0) { 'already-off'; exit }
# 0x40 = ENABLE_QUICK_EDIT_MODE；必须同时置 0x80 = ENABLE_EXTENDED_FLAGS，修改才会生效
if ($k::SetConsoleMode($h, [uint32](($mode -band (-bnot 0x40)) -bor 0x80))) { 'disabled' } else { 'failed' }
`;

export type QuickEditResult = "disabled" | "already-off" | "no-console" | "failed" | "skipped";

/** 尽力而为：失败只返回结果，不抛错、不阻断启动。非 Windows 或输出不是控制台时直接跳过。 */
export function disableConsoleQuickEdit(): Promise<QuickEditResult> {
  if (process.platform !== "win32" || !process.stdout.isTTY) return Promise.resolve("skipped");
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", Buffer.from(DISABLE_QUICK_EDIT_PS, "utf16le").toString("base64"),
      ], {
        // 不能 windowsHide：那会让子进程脱离当前控制台，CONIN$ 就打不开了
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve("failed");
      return;
    }
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve("failed"); });
    child.on("close", () => {
      clearTimeout(timer);
      const result = out.trim().split(/\r?\n/).pop() ?? "";
      resolve((["disabled", "already-off", "no-console"] as const).find((r) => r === result) ?? "failed");
    });
  });
}
