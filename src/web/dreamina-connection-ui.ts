import type { DreaminaConnectionState } from "../application/services/dreamina-connection-service.js";
import { layout } from "./workbench-ui.js";
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderDreaminaConnectionPage(state: DreaminaConnectionState): string {
  return layout("连接即梦 CLI", `<h1>连接即梦 CLI</h1>
<p class="muted">此连接用于当前 PVS 实例的视频生成。登录状态由即梦 CLI 保存在运行本实例的电脑或服务器上；连接和检查不会提交生成任务。</p>
<section class="card"><h2>即梦连接</h2><p id="connection-status" role="status">${esc(state.message)}</p>
<p id="connection-version">${state.cliVersion ? "CLI 版本：" + esc(state.cliVersion) : ""}</p>
<div class="actions"><button id="connect-dreamina" type="button">连接 / 登录即梦 CLI</button> <button class="secondary" id="check-dreamina" type="button">重新检测</button></div>
<div id="authorization" hidden><p><a class="primary" id="authorization-link" target="_blank" rel="noopener noreferrer">打开即梦官方授权页</a></p><p>如官方页面要求授权码，请输入：<strong id="authorization-code"></strong></p><p id="authorization-expiry" class="muted"></p><button id="confirm-dreamina" type="button">我已授权，确认连接</button></div>
</section>
<section class="card"><details${state.status === "NOT_INSTALLED" || state.status === "UNVERIFIED" ? " open" : ""}><summary>安装与配置</summary>
<p>若提示未安装，请在运行当前 PVS 实例的电脑或服务器上安装官方 Dreamina CLI，再重新检测。在其他电脑安装不会改变本实例的状态。</p>
<p><a href="https://jimeng.jianying.com/ai-tool/install" target="_blank" rel="noopener noreferrer">查看即梦官方安装说明</a></p>

<details><summary>高级配置</summary><p>管理员可通过 DREAMINA_VERIFIED_RUNTIME_CONFIG 指定已核验的运行时配置，更新后重启本实例。CLI 路径和校验值必须与实际安装匹配。</p><p>已检测路径：${esc(state.executablePath || "未找到")}</p></details>
</details></section><p><a href="/health-center">返回系统诊断</a> · <a href="/agent">打开视频生成</a></p>
<script>(()=>{const $=id=>document.getElementById(id),buttons=['connect-dreamina','check-dreamina','confirm-dreamina'];
function show(s){$('connection-status').textContent=s.message;$('connection-version').textContent=s.cliVersion?'CLI 版本：'+s.cliVersion:'';$('authorization').hidden=!s.authorizationUrl;$('connect-dreamina').hidden=s.status==='AUTHENTICATED';if(s.authorizationUrl){const u=new URL(s.authorizationUrl);if(u.protocol==='https:'&&u.origin==='https://jimeng.jianying.com'){$('authorization-link').href=u.href;$('authorization-code').textContent=s.userCode||'';$('authorization-expiry').textContent=s.expiresAt?'授权有效期至：'+new Date(s.expiresAt).toLocaleString():'';}else{$('authorization').hidden=true;}}}
async function call(path,method){buttons.forEach(id=>$(id).disabled=true);$('connection-status').textContent='正在检查即梦连接…';try{const r=await fetch('/api/dreamina/connection'+path,{method});const s=await r.json();if(!r.ok)throw Error(s.message||'连接失败');show(s);}catch(e){$('connection-status').textContent=e.message;}finally{buttons.forEach(id=>$(id).disabled=false);}}
$('authorization-link').onclick=e=>{if(typeof window.runtime?.BrowserOpenURL==='function'){e.preventDefault();window.runtime.BrowserOpenURL($('authorization-link').href);}};
$('connect-dreamina').onclick=()=>call('/login','POST');$('check-dreamina').onclick=()=>call('','GET');$('confirm-dreamina').onclick=()=>call('/confirm','POST');call('','GET');})();</script>`);
}
