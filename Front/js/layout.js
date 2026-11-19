/* Shared dashboard layout: sidebar, top bar and page frame.
   Every dashboard page calls SP.mount('<key>') after defining V.<key> (and optionally BIND.<key>). */
const NAV=[['overview','Overview','overview'],['operations','Port operation center','ops'],['vessels','Vessels & berths','vessel'],['cargo','Cargo & containers','cargo'],['yard','Yard & smart gate','yard'],['services','Services & billing','bill'],['equipment','Equipment & fleet','tool'],['gis','GIS & analytics','map']];
const V={},BIND={};
const SP={
  shell(user){const allowed=k=>SP_AUTH_UTIL.canViewPage(user,k);return `
  <aside class="rail">
    <a class="brand" href="overview.html" style="text-decoration:none"><svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><path d="M12 7.5V21M7 11h10M4 15c0 3.5 3.5 6 8 6s8-2.5 8-6"/></svg>SmartPort</a>
    <div class="ws"><b>Port of Rotterdam</b><span>NLRTM / MAASVLAKTE · dữ liệu mẫu</span></div>
    <div class="navlabel">Workspace</div>
    <nav class="nav" id="nav" aria-label="Workspace">${NAV.filter(n=>allowed(n[0])).map(n=>`<a href="${n[0]}.html" data-r="${n[0]}">${ic(n[2])}${n[1]}</a>`).join('')}</nav>
    ${allowed('admin')?`<div class="navlabel">Administration</div>
    <nav class="nav admin" aria-label="Administration"><a href="admin.html">Users &amp; access</a><a href="admin.html">Audit log</a><a href="admin.html">Settings</a></nav>`:''}
    <div class="spacer"></div>
    <div class="sys"><i></i>System status (sample)<small>Chưa có giám sát thật</small></div>
    <div class="me"><div class="av" id="meAv"></div><div><b id="meName"></b><span id="meRole"></span></div><a href="login.html" id="signout" style="margin-left:auto;font-size:11px">Sign out</a></div>
  </aside>
  <div class="main">
    <div class="top">
      <div class="crumb"><span>Workspace</span><span>/</span><b id="crumb"></b></div>
      <label class="search"><svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg><input id="q" placeholder="Search (not available yet)" aria-label="Search" disabled><kbd>⌘ K</kbd></label>
      <span class="clock" id="clock" title="Giờ hiện tại (UTC+7)"></span>
      <button class="alerts" type="button" disabled title="Chưa triển khai">Alerts</button>
      <button class="theme" id="theme" type="button" aria-label="Toggle theme"></button>
    </div>
    <div class="banner" id="banner" role="alert" hidden></div>
    <div class="page" id="view"></div>
  </div>`},
  pending(title){return `<div class="head"><div><h1>${title}</h1></div></div><div class="pend"><div><h2>Screen not built yet</h2><p>This screen exists in the Figma file but has not been implemented in this app.</p></div></div>`},
  /* Protected page entry (UC-001/UC-002): the page renders only after the API confirms the session.
     States: loading, error with retry (server unreachable), or redirect to login (no or expired session).
     The API enforces authorization on every request; the role shown here is for display only. */
  mount(key,title){
    const app=$('#app');app.className='';
    app.innerHTML='<div class="pend" aria-busy="true"><div><h2>Loading…</h2><p>Checking your session.</p></div></div>';
    SP_AUTH.requireSession().then(user=>SP.render(key,title,user)).catch(err=>{
      app.innerHTML='<div class="pend"><div><h2>Cannot reach the server</h2><p id="mErr"></p><button class="btn" id="retry" type="button">Retry</button></div></div>';
      $('#mErr').textContent=err&&err.message?err.message:'Đã xảy ra lỗi. Vui lòng thử lại.';
      $('#retry').onclick=()=>SP.mount(key,title);
    });
  },
  render(key,title,user){
    const app=$('#app');app.className='shell';app.innerHTML=SP.shell(user);
    $('#meName').textContent=user.displayName;$('#meRole').textContent=SP_AUTH_UTIL.roleLabel(user.roles);$('#meAv').textContent=SP_AUTH_UTIL.initials(user.displayName);
    $('#signout').onclick=async e=>{e.preventDefault();const a=e.currentTarget;a.setAttribute('aria-disabled','true');a.textContent='Signing out…';
      try{await SP_AUTH.logout()}catch(err){a.removeAttribute('aria-disabled');a.textContent='Sign out';const b=$('#banner');b.textContent='Không thể đăng xuất: '+(err&&err.message?err.message:'lỗi không xác định')+' Phiên vẫn còn hiệu lực. Vui lòng thử lại.';b.hidden=false}};
    const nav=NAV.find(n=>n[0]==key);
    const name=title||(nav?nav[1]:'Administration');
    $('#crumb').textContent=name;document.title=name+' · SmartPort';
    document.querySelectorAll('#nav a').forEach(a=>{if(a.dataset.r==key)a.setAttribute('aria-current','page')});
    /* Usability only: the menu already hides pages the role cannot use. A direct visit gets a clear message. The API
       refuses the data anyway, because it checks the permission matrix on every request. */
    const permitted=SP_AUTH_UTIL.canViewPage(user,key);
    $('#view').innerHTML=permitted?V[key]():`<div class="pend"><div><h2>Access not permitted</h2><p>Your role does not include this area.</p><a class="btn pri" id="gohome" href="${SP_AUTH_UTIL.homeFor(user)}">Go to my workspace</a></div></div>`;
    const tick=()=>{const c=$('#clock');if(c)c.textContent=new Date(Date.now()+7*3600e3).toISOString().slice(11,16)+' UTC+7'};tick();setInterval(tick,30000);
    const tb=$('#theme');
    const label=()=>tb.textContent=document.documentElement.dataset.theme=='dark'?'Light':'Dark';label();
    tb.onclick=()=>{const t=document.documentElement.dataset.theme=='dark'?'light':'dark';document.documentElement.dataset.theme=t;try{localStorage.setItem('sp-theme',t)}catch(e){}label()};
    if(permitted&&BIND[key])BIND[key]();
  }
};
