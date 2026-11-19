const LOGIN=`<header><div class="brand"><svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.200"/><path d="M12 7.500V21M7 11h10M4 15c0 3.500 3.500 6 8 6s8-2.500 8-6"/></svg>SmartPort<small>Port of Rotterdam</small></div><div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap"><span>English ▾</span><span>Help &amp; support ↗</span><span class="secure">Secure access</span></div></header>
<main class="lgm"><div><div class="eyebrow">Smart seaport operations</div><h1>One port. One operational view.</h1><p class="lead">Connect vessel operations, cargo, yard and equipment in a secure workspace built for every shift.</p>
 <section class="panel"><div class="ph" style="padding-bottom:12px"><div><h2>Port of Rotterdam</h2><div class="sub">NLRTM · Maasvlakte terminals</div></div><span style="color:var(--accent);font-size:11px">Operational workspace</span></div><div class="map" style="margin:0;border-left:0;border-right:0">${portSvg({h:200,id:3})}</div><div class="tfoot" style="border:0"><span>24 vessels in port · 22 berths</span><span>UTC+2</span></div></section>
 <section class="panel rt"><div class="ph"><div><h2>Your role determines your workspace</h2><div class="sub">Permissions are assigned by your port administrator.</div></div></div><div style="height:12px"></div><table><thead><tr><th>Role</th><th>Access scope</th></tr></thead><tbody><tr><td>Operations manager</td><td>Port-wide monitoring, planning &amp; approvals</td></tr><tr><td>Terminal operator</td><td>Assigned terminal, cargo &amp; yard operations</td></tr><tr><td>Service partner</td><td>Own service requests, appointments &amp; invoices</td></tr></tbody></table></section>
 <div class="trust">${ic('shield')}<span>Role-based access · Multi-factor authentication · Audited sessions. Only authorized personnel may access port operational data.</span></div></div>
 <div><section class="panel card"><h2>Sign in to SmartPort</h2><p class="s">Use your port-issued account to continue.</p>
 <form id="lf"><div class="f"><label for="lw">Workspace</label><select id="lw"><option>Port of Rotterdam · NLRTM</option><option>Port of Antwerp-Bruges · BEANR</option></select></div>
 <div class="f"><label for="le">Username</label><input id="le" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="100" aria-describedby="e-le"><div class="fe" id="e-le" role="alert"></div></div>
 <div class="f"><label for="lp">Password</label><div class="pw"><input id="lp" type="password" autocomplete="current-password" maxlength="256" aria-describedby="e-lp"><button type="button" id="sh">Show</button></div><div class="fe" id="e-lp" role="alert"></div></div>
 <div class="fr"><span></span><a href="login.html">Forgot password?</a></div>
 <div class="lmsg" id="lmsg" role="alert" hidden></div>
 <button class="btn pri w" type="submit" id="lsub">Sign in securely →</button></form><div class="or">or</div><button class="btn w" type="button" id="sso" disabled title="Single sign-on is not available yet">Continue with port SSO</button><div class="idp">Microsoft Entra ID · Organization-managed identity</div></section>
 <section class="panel mfa"><div><b>Next: verify your identity</b><p>After sign-in, approve the request in your authenticator app or enter a 6-digit code. MFA is required for all operational roles.</p><a href="login.html">Lost your device? Use a recovery code →</a></div><span class="pill info">Required</span></section>
 <p style="text-align:center;color:var(--mute);margin-top:22px">Need an account or a different role?<br><a href="login.html">Request access from your administrator →</a></p></div></main>
<footer><span>© 2026 SmartPort · Port of Rotterdam</span><span style="display:flex;gap:20px;flex-wrap:wrap"><span>Privacy policy</span><span>Terms of use</span><span>System status</span></span><span>Sessions expire after 30 minutes of inactivity</span></footer>`;

$('#login').innerHTML=LOGIN;
$('#sh').onclick=()=>{const p=$('#lp'),s=p.type=='password';p.type=s?'text':'password';$('#sh').textContent=s?'Hide':'Show'};

/* UC-001: real sign-in through SP_AUTH (central API client). No credentials are stored client-side. */
const setMsg=(text,kind)=>{const m=$('#lmsg');m.textContent=text||'';m.hidden=!text;m.className='lmsg'+(kind?' '+kind:'')};
const setFieldErrors=errs=>{$('#e-le').textContent=errs.username||'';$('#e-lp').textContent=errs.password||'';
  $('#le').setAttribute('aria-invalid',errs.username?'true':'false');$('#lp').setAttribute('aria-invalid',errs.password?'true':'false')};
$('#lf').noValidate=true;
const REASONS={expired:'Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.',
  offline:'Không kết nối được máy chủ nên chưa thể thu hồi phiên trên máy chủ. Phiên trên trình duyệt này đã được xóa; phiên trên máy chủ sẽ tự hết hạn sau 30 phút không hoạt động.',
  noaccess:'Tài khoản này chưa được cấp quyền truy cập chức năng nào. Vui lòng liên hệ Quản trị hệ thống.'};
const reason=new URLSearchParams(location.search).get('reason');
if(REASONS[reason])setMsg(REASONS[reason],'warn');
// Already signed in? Go to the workspace, except right after the user signed out offline or has no access.
SP_AUTH.peek().then(u=>{if(u&&reason!=='noaccess'&&reason!=='offline')location.replace(SP_AUTH_UTIL.homeFor(u))});
$('#lf').onsubmit=async e=>{
  e.preventDefault();
  const username=$('#le').value,password=$('#lp').value,errs=SP_AUTH_UTIL.validateCredentials(username,password);
  setFieldErrors(errs);setMsg('');
  if(Object.keys(errs).length){($('#le').getAttribute('aria-invalid')==='true'?$('#le'):$('#lp')).focus();return}
  const btn=$('#lsub');btn.disabled=true;btn.textContent='Signing in…';
  try{const u=await SP_AUTH.login(username,password);location.replace(SP_AUTH_UTIL.homeFor(u))}
  catch(err){
    $('#lp').value='';
    if(err&&err.code==='VALIDATION_FAILED'&&Array.isArray(err.details)){const m={};err.details.forEach(d=>{m[d.field]=d.message});setFieldErrors(m)}
    setMsg(err&&err.message?err.message:'Đã xảy ra lỗi. Vui lòng thử lại.','bad');
    btn.disabled=false;btn.textContent='Sign in securely →';$('#lp').focus();
  }
};
