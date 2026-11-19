/* Module 1 screens with live data from the API (through SP_RES): vessel registry (UC-010, UC-011), arrival notices with
   drafts and automatic validation (UC-013, UC-015) and the berth queue (UC-020). Loading, empty and error states are shown
   for every list. Buttons are shown by permission for usability only; the API refuses anything the role may not do.
   All dynamic text is escaped before it is placed in HTML. */
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const PILL={ANNOUNCED:'info',MISSING_DOCUMENTS:'warn',REJECTED:'bad',VALIDATED:'ok',WAITING_BERTH:'ok',BERTH_ASSIGNED:'info',BERTHED:'ok',DEPARTED:'mute'};
const SHIP_FIELDS=['imo_number','ship_name','ship_type_id','flag_state','operator_agent_id','length_overall_m','beam_m','max_draft_m','deadweight_t'];
const NOTICE_FIELDS=['ship_id','voyage_code','agent_id','origin_port_id','declared_eta','declared_teu','cargo_type','service_request','priority_class'];

const VR={
  s:{sch:{view:'list',mode:'day',date:SP_RES_UTIL.todayLocal(),status:'',agent:'',berth:'',page:0},shipPage:0,noticePage:0,search:'',inactive:false,timer:null,flashTimer:null,queue:{revision:null,items:[]}},
  can:a=>SP_AUTH_UTIL.can(SP_AUTH.user,'M1_VESSELS',a),

  /* ---------- markup ---------- */
  registryPanel(){return `<section class="panel" id="reg"><div class="ph"><div><h2>Đăng ký tàu · Vessel registry</h2><div class="sub">Vessel profiles · live data</div></div>
    <button class="btn pri" id="addShip" type="button" hidden>+ Add vessel</button></div>
    <div class="filters" style="padding:12px 16px"><label class="search"><input id="shipQ" type="search" maxlength="100" placeholder="Search by IMO or vessel name" aria-label="Search vessels"></label>
    <label style="display:flex;gap:6px;align-items:center;color:var(--mute);font-size:12px"><input type="checkbox" id="shipInactive"> Show inactive</label></div>
    <div id="shipList" aria-live="polite"></div></section>`},
  queuePanel(){return `<section class="panel" id="que"><div class="ph"><div><h2>Hàng đợi cập bến · Berth queue</h2><div class="sub">Valid notices waiting for a berth · priority first, then ETA · live data · times in UTC+7</div></div><button class="btn pri" id="recBtn" type="button" data-bact="rec-open" hidden>Đề xuất bến</button></div><div style="height:12px"></div>
    <div id="queueList" aria-live="polite"></div></section>`},
  noticePanel(){return `<section class="panel" id="ntc"><div class="ph"><div><h2>Thông báo tàu đến · Arrival notices</h2><div class="sub">Notices are validated automatically when submitted · live data · times in UTC+7</div></div>
    <button class="btn pri" id="addNotice" type="button" hidden>+ New arrival notice</button></div><div id="draftBox" hidden><h3 class="sect">My drafts</h3><div id="draftList" aria-live="polite"></div></div><div style="height:12px"></div>
    <div id="noticeList" aria-live="polite"></div></section>`},

  stateBox:(kind,title,msg,retry)=>`<div class="pend" style="min-height:120px"><div><h2>${esc(title)}</h2>${msg?`<p>${esc(msg)}</p>`:''}${retry?`<button class="btn" type="button" data-retry="${retry}">Retry</button>`:''}</div></div>`,
  paging(total,page,size,key){const pages=Math.max(1,Math.ceil(total/size));const from=total?page*size+1:0,to=Math.min(total,(page+1)*size);
    return `<div class="tfoot"><span>Showing ${from}–${to} of ${total}</span><span class="pg"><button type="button" class="btn" data-pg="${key}:prev" ${page<=0?'disabled':''} aria-label="Previous page">‹</button> <b>${page+1}</b> / ${pages} <button type="button" class="btn" data-pg="${key}:next" ${page+1>=pages?'disabled':''} aria-label="Next page">›</button></span></div>`},

  shipTable(d){const edit=VR.can('edit');
    if(!d.items.length)return VR.stateBox('empty','Không có dữ liệu',VR.s.search?'Không có tàu nào khớp từ khóa tìm kiếm.':'Chưa có hồ sơ tàu nào.');
    return `<div class="tw"><table><thead><tr><th>Vessel / IMO</th><th>Type</th><th>LOA × beam × draft (m)</th><th>Agent</th><th>Status</th>${edit?'<th>Actions</th>':''}</tr></thead><tbody>${d.items.map(s=>`<tr data-ship="${s.id}">
      <td><button type="button" class="linkbtn" data-act="detail" data-id="${s.id}">${esc(s.ship_name)}</button><br><small class="mono" style="color:var(--dim);font-size:10px">IMO ${esc(s.imo_number)}</small></td>
      <td>${esc(s.ship_type_name)}</td><td class="mono num">${esc(s.length_overall_m)} × ${esc(s.beam_m)} × ${esc(s.max_draft_m)}</td>
      <td>${esc(s.operator_agent_name||'—')}</td><td><span class="pill ${s.is_active?'ok':'mute'}">${s.is_active?'Active':'Inactive'}</span></td>
      ${edit?`<td><button class="btn" type="button" data-act="edit" data-id="${s.id}">Edit</button> ${s.is_active?`<button class="btn" type="button" data-act="deactivate" data-id="${s.id}">Deactivate</button>`:''}</td>`:''}</tr>`).join('')}</tbody></table></div>${VR.paging(d.total,d.page,d.size,'ship')}`},

  noticeTable(d){const canNotice=VR.can('notice');
    if(!d.items.length)return VR.stateBox('empty','Không có dữ liệu','Chưa có thông báo tàu đến nào.');
    return `<div class="tw"><table><thead><tr><th>Vessel / voyage</th><th>Origin</th><th>ETA (UTC+7)</th><th>TEU</th><th>Status</th><th>Agent</th>${canNotice?'<th>Actions</th>':''}</tr></thead><tbody>${d.items.map(v=>`<tr data-voyage="${v.id}">
      <td><b style="font-weight:500">${esc(v.ship_name)}</b><br><small class="mono" style="color:var(--dim);font-size:10px">${esc(v.voyage_code)} · IMO ${esc(v.imo_number)}</small></td>
      <td>${esc(v.origin_port_name)}</td><td class="mono num">${esc(SP_RES_UTIL.formatUtc7(v.declared_eta))}</td><td class="mono num">${esc(v.declared_teu)}</td>
      <td><span class="pill ${PILL[v.status]||'mute'}">${esc(v.status)}</span>${v.queue_position?` <small class="mono">queue #${esc(v.queue_position)}</small>`:''}${v.validation_reason&&v.status!=='WAITING_BERTH'?`<br><small style="color:var(--mute)">${esc(v.validation_reason)}</small>`:''}</td><td>${esc(v.agent_name)}</td>
      ${canNotice?`<td>${v.status==='MISSING_DOCUMENTS'||v.status==='ANNOUNCED'?`<button class="btn" type="button" data-act="revalidate" data-id="${v.id}">Validate again</button>`:''}</td>`:''}</tr>`).join('')}</tbody></table></div>${VR.paging(d.total,d.page,d.size,'notice')}`},

  draftTable(items){
    if(!items.length)return '<p style="color:var(--dim);padding:0 16px 8px">Không có bản nháp.</p>';
    return `<div class="tw"><table><thead><tr><th>Draft</th><th>ETA (UTC+7)</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${items.map(d=>`<tr data-draft="${d.id}">
      <td><b style="font-weight:500">${esc(d.payload.voyage_code||'(no voyage code)')}</b><br><small style="color:var(--dim)">${esc(d.payload.cargo_type||'')}</small></td>
      <td class="mono num">${esc(SP_RES_UTIL.formatUtc7(d.payload.declared_eta)||'—')}</td><td class="mono num">${esc(SP_RES_UTIL.formatUtc7(d.updated_at))}</td>
      <td><button class="btn" type="button" data-act="draft-edit" data-id="${d.id}">Edit</button> <button class="btn pri" type="button" data-act="draft-submit" data-id="${d.id}">Submit</button> <button class="btn" type="button" data-act="draft-discard" data-id="${d.id}">Discard</button></td></tr>`).join('')}</tbody></table></div>`},

  queueTable(q){const edit=VR.can('edit'),chk=typeof BP!=='undefined'&&BP.can('view'),acts=edit||chk;
    if(!q.items.length)return VR.stateBox('empty','Không có dữ liệu','Chưa có chuyến nào trong hàng đợi chờ cập bến.');
    return `<div class="tw"><table><thead><tr><th>#</th><th>Vessel / voyage</th><th>Priority</th><th>Effective ETA (UTC+7)</th><th>Agent</th>${acts?'<th>Actions</th>':''}</tr></thead><tbody>${q.items.map(e=>`<tr data-queue="${e.voyage_id}">
      <td class="mono num"><b>${esc(e.position)}</b></td>
      <td><b style="font-weight:500">${esc(e.ship_name)}</b><br><small class="mono" style="color:var(--dim);font-size:10px">${esc(e.voyage_code)} · IMO ${esc(e.imo_number)}</small></td>
      <td><span class="pill ${e.priority_class==='STANDARD'?'mute':'info'}">${esc(e.priority_class)}</span></td>
      <td class="mono num">${esc(SP_RES_UTIL.formatUtc7(e.effective_eta))} <span class="pill ${e.eta_source==='AI'?'ok':e.eta_status==='PENDING'?'info':'mute'}" data-eta-tag="${e.eta_source==='AI'?'AI':e.eta_status==='PENDING'?'PENDING':'DECLARED'}">${e.eta_source==='AI'?'AI forecast':e.eta_status==='PENDING'?'declared · AI pending':'declared'}</span></td><td>${esc(e.agent_name)}</td>
      ${acts?`<td>${edit?`<button class="btn" type="button" data-act="move" data-id="${e.voyage_id}">Move</button> `:''}${chk?`<button class="btn" type="button" data-act="berth-check" data-id="${e.voyage_id}">Check berth</button>`:''}</td>`:''}</tr>`).join('')}</tbody></table></div><div class="tfoot"><span>Queue version ${esc(q.revision)}</span><span>${q.items.length} waiting</span></div>`},

  /* ---------- loading ---------- */
  async loadShips(){const box=$('#shipList');box.innerHTML=VR.stateBox('loading','Loading…');
    try{const d=await SP_RES.listShips({search:VR.s.search,includeInactive:VR.s.inactive,page:VR.s.shipPage,size:10});box.innerHTML=VR.shipTable(d)}
    catch(e){box.innerHTML=VR.stateBox('error','Không tải được danh sách tàu',e.message,'ships')}},
  async loadNotices({silent}={}){const box=$('#noticeList');if(!box)return;if(!silent)box.innerHTML=VR.stateBox('loading','Loading…');
    try{const d=await SP_RES.listVoyages({page:VR.s.noticePage,size:10});const sig=JSON.stringify(d);if(silent&&VR.s.noticeSig===sig&&box.innerHTML)return;VR.s.noticeSig=sig;box.innerHTML=VR.noticeTable(d)}
    catch(e){if(!silent)box.innerHTML=VR.stateBox('error','Không tải được thông báo tàu đến',e.message,'notices')}},
  async loadDrafts(){const box=$('#draftList');if(!box||!VR.can('notice'))return;$('#draftBox').hidden=false;box.innerHTML='<p style="color:var(--dim);padding:0 16px">Loading…</p>';
    try{VR.s.drafts=await SP_RES.listDrafts();box.innerHTML=VR.draftTable(VR.s.drafts)}
    catch(e){box.innerHTML=VR.stateBox('error','Không tải được bản nháp',e.message,'drafts')}},
  async loadQueue({silent}={}){const box=$('#queueList');if(!box)return;if(!silent)box.innerHTML=VR.stateBox('loading','Loading…');
    try{const q=await SP_RES.getQueue();VR.s.queue=q;if(typeof BC!=='undefined'&&BC.s.loaded)BC.draw();const sig=JSON.stringify(q);if(silent&&VR.s.queueSig===sig&&box.innerHTML)return;VR.s.queueSig=sig;box.innerHTML=VR.queueTable(q)}
    catch(e){if(!silent)box.innerHTML=VR.stateBox('error','Không tải được hàng đợi',e.message,'queue')}},
  reloadWorkflow(){VR.loadNotices();VR.loadQueue();VR.loadDrafts()},

  flash(text,kind){const b=$('#banner');b.textContent=text;b.className='banner'+(kind==='ok'?' ok':'');b.hidden=false;clearTimeout(VR.s.flashTimer);VR.s.flashTimer=setTimeout(()=>{b.hidden=true},8000)},

  /* ---------- dialog and form helpers ---------- */
  dialog(html){let d=$('#vdlg');if(!d){d=document.createElement('dialog');d.id='vdlg';document.body.appendChild(d);d.addEventListener('click',e=>{if(e.target===d)d.close()});
    d.addEventListener('close',()=>{d.innerHTML=''})} // a closed dialog keeps no stale form behind (also on Esc)
    d.innerHTML=`<div class="dlg">${html}</div>`;if(!d.open)d.showModal();const first=d.querySelector('input,select,textarea');if(first)first.focus();return d},
  close(){const d=$('#vdlg');if(d&&d.open)d.close()},
  fld:(id,label,control)=>`<div class="f"><label for="f-${id}">${label}</label>${control}<div class="fe" id="e-${id}" role="alert"></div></div>`,
  opts:(list,sel,blank)=>(blank?`<option value="">${esc(blank)}</option>`:'')+list.map(o=>`<option value="${o.id}"${String(o.id)===String(sel)?' selected':''}>${esc(o.name)}</option>`).join(''),
  clearErrors(f){f.querySelectorAll('.fe').forEach(e=>{e.textContent=''});f.querySelectorAll('[aria-invalid]').forEach(e=>e.removeAttribute('aria-invalid'));const m=f.querySelector('#fmsg');m.textContent='';m.hidden=true},
  showErrors(f,err,fields){VR.clearErrors(f);const unplaced=[];
    const place=(field,message)=>{const e=f.querySelector('#e-'+field);if(e&&fields.includes(field)){e.textContent=message;const i=f.querySelector('#f-'+field);if(i)i.setAttribute('aria-invalid','true')}else unplaced.push(message)};
    if(err.code==='VALIDATION_FAILED'&&Array.isArray(err.details))err.details.forEach(d=>place(d.field,d.message));
    else if(err.details&&err.details.field)place(err.details.field,err.details.message||err.message);
    else unplaced.push(err.message+(err.details&&err.details.voyages?' ('+err.details.voyages.map(v=>v.voyage_code).join(', ')+')':''));
    if(unplaced.length){const m=f.querySelector('#fmsg');m.textContent=unplaced.join(' ');m.hidden=false}
    const bad=f.querySelector('[aria-invalid]');if(bad)bad.focus()},
  busy(f,on,label){const b=f.querySelector('button[type=submit]');b.disabled=on;b.textContent=on?'Saving…':label},
  num:s=>s.trim()===''?null:Number(s),
  blank:s=>s.trim()===''?null:s.trim(),

  /* ---------- UC-010 create and UC-011 edit ---------- */
  async openShipForm(ship){
    VR.dialog('<h2 style="margin:0 0 14px">Loading…</h2>');
    let types,agents;try{[types,agents]=await Promise.all([SP_RES.shipTypes(),SP_RES.agents()])}
    catch(e){VR.dialog(`<h2 style="margin:0 0 8px">Không tải được danh mục</h2><p>${esc(e.message)}</p><button class="btn" type="button" data-close>Close</button>`);return}
    const s=ship||{},editing=!!ship;
    const input=(id,val,extra='')=>`<input id="f-${id}" name="${id}" value="${esc(val==null?'':val)}" ${extra}>`;
    VR.dialog(`<h2 style="margin:0 0 4px">${editing?'Edit vessel':'Add vessel'}</h2><p class="sub" style="margin:0 0 14px;color:var(--dim)">${editing?'IMO '+esc(s.imo_number):'Create a vessel profile'}</p>
     <form id="vf" novalidate><div class="grid2">
      ${VR.fld('imo_number','IMO number',input('imo_number',s.imo_number,'maxlength="7" inputmode="numeric" autocomplete="off"'))}
      ${VR.fld('ship_name','Vessel name',input('ship_name',s.ship_name,'maxlength="200"'))}
      ${VR.fld('ship_type_id','Vessel type',`<select id="f-ship_type_id">${VR.opts(types,s.ship_type_id,'Select…')}</select>`)}
      ${VR.fld('flag_state','Flag',input('flag_state',s.flag_state,'maxlength="100"'))}
      ${VR.fld('operator_agent_id','Operator / agent',`<select id="f-operator_agent_id">${VR.opts(agents,s.operator_agent_id,'— none —')}</select>`)}
      ${VR.fld('length_overall_m','LOA (m)',input('length_overall_m',s.length_overall_m,'type="number" step="0.01" min="0"'))}
      ${VR.fld('beam_m','Beam (m)',input('beam_m',s.beam_m,'type="number" step="0.01" min="0"'))}
      ${VR.fld('max_draft_m','Max draft (m)',input('max_draft_m',s.max_draft_m,'type="number" step="0.01" min="0"'))}
      ${VR.fld('deadweight_t','Deadweight (t)',input('deadweight_t',s.deadweight_t,'type="number" step="0.01" min="0"'))}
     </div>${editing?VR.fld('reason','Reason for change (optional)','<textarea id="f-reason" maxlength="500" rows="2"></textarea>'):''}
     <div class="lmsg bad" id="fmsg" role="alert" hidden></div>
     <div class="stack"><button class="btn pri" type="submit">${editing?'Save changes':'Create vessel'}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
    const f=$('#vf');
    f.onsubmit=async e=>{e.preventDefault();const g=id=>f.querySelector('#f-'+id).value;
      const body={imo_number:g('imo_number').trim(),ship_name:g('ship_name').trim(),ship_type_id:g('ship_type_id')===''?null:Number(g('ship_type_id')),flag_state:VR.blank(g('flag_state')),
        operator_agent_id:g('operator_agent_id')===''?null:Number(g('operator_agent_id')),length_overall_m:VR.num(g('length_overall_m')),beam_m:VR.num(g('beam_m')),max_draft_m:VR.num(g('max_draft_m')),deadweight_t:VR.num(g('deadweight_t'))};
      let send=body;
      if(editing){send={};SHIP_FIELDS.forEach(k=>{if(body[k]!==(s[k]===undefined?null:s[k]))send[k]=body[k]});
        if(!Object.keys(send).length){VR.showErrors(f,{code:'LOCAL',message:'Không có thay đổi nào để lưu.'},SHIP_FIELDS);return}
        const reason=VR.blank(g('reason'));if(reason)send.reason=reason}
      VR.busy(f,true);
      try{const saved=editing?await SP_RES.updateShip(s.id,s.revision,send):await SP_RES.createShip(send);
        VR.flash((editing?'Đã cập nhật tàu ':'Đã tạo hồ sơ tàu ')+saved.ship_name+'.','ok');
        if(editing)VR.close();else VR.openDetail(saved); // UC-010 step 5: show the saved vessel's detail page
        VR.loadShips()}
      catch(err){VR.busy(f,false,editing?'Save changes':'Create vessel');
        if(editing&&err.status===409&&err.details&&err.details.current_revision!==undefined){ // someone else changed the record: reload it
          try{const fresh=await SP_RES.getShip(s.id);await VR.openShipForm(fresh);const nf=$('#vf'),m=nf.querySelector('#fmsg');m.textContent='Hồ sơ tàu vừa được người khác thay đổi. Dữ liệu mới nhất đã được tải lại; vui lòng kiểm tra rồi lưu lại.';m.hidden=false;return}catch(e2){}}
        VR.showErrors(f,err,SHIP_FIELDS)}};
  },

  /* ---------- vessel detail and change history (UC-010 step 5, UC-011 AC-1) ---------- */
  ACTION:{SHIP_CREATE:'Created',SHIP_UPDATE:'Updated',SHIP_DEACTIVATE:'Deactivated'},
  FIELD:{imo_number:'IMO',ship_name:'Name',flag_state:'Flag',ship_type:'Type',operator_agent:'Agent',length_overall_m:'LOA (m)',beam_m:'Beam (m)',max_draft_m:'Max draft (m)',deadweight_t:'Deadweight (t)',is_active:'Active'},
  historyHtml(items){
    if(!items.length)return '<p style="color:var(--dim)">Không có dữ liệu</p>';
    const changes=h=>h.changes.length?'<ul>'+h.changes.map(c=>`<li>${esc(VR.FIELD[c.field]||c.field)}: ${esc(c.old==null?'—':c.old)} → ${esc(c.new==null?'—':c.new)}</li>`).join('')+'</ul>':'';
    return '<ol class="hist">'+items.map(h=>`<li><b>${esc(VR.ACTION[h.action]||h.action)}</b> · ${esc(SP_RES_UTIL.formatUtc7(h.at))} · ${esc(h.actor)}${h.reason?' — '+esc(h.reason):''}${changes(h)}</li>`).join('')+'</ol>'},
  async openDetail(ship){
    const row=(k,v)=>`<dt>${k}</dt><dd>${esc(v==null||v===''?'—':v)}</dd>`;
    VR.dialog(`<div id="vdetail"><h2 style="margin:0 0 4px">${esc(ship.ship_name)}</h2><p style="margin:0 0 14px;color:var(--dim)">IMO ${esc(ship.imo_number)} · <span class="pill ${ship.is_active?'ok':'mute'}">${ship.is_active?'Active':'Inactive'}</span></p>
     <dl class="dtl" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 18px">${row('Type',ship.ship_type_name)}${row('Flag',ship.flag_state)}${row('Operator / agent',ship.operator_agent_name)}${row('LOA (m)',ship.length_overall_m)}${row('Beam (m)',ship.beam_m)}${row('Max draft (m)',ship.max_draft_m)}${row('Deadweight (t)',ship.deadweight_t)}${row('Ship code',ship.ship_code)}</dl>
     <h3 style="margin:18px 0 6px;font-size:14px">Change history</h3><div id="vhist"><p style="color:var(--dim)">Loading…</p></div>
     <div class="stack">${VR.can('edit')?`<button class="btn pri" type="button" data-act="edit" data-id="${ship.id}">Edit</button>`:''}<button class="btn" type="button" data-close>Close</button></div></div>`);
    try{const items=await SP_RES.shipHistory(ship.id);const h=$('#vhist');if(h)h.innerHTML=VR.historyHtml(items)}
    catch(e){const h=$('#vhist');if(h)h.innerHTML='<p>Không tải được lịch sử: '+esc(e.message)+'</p>'}
  },

  /* ---------- UC-011 deactivate ---------- */
  async openDeactivate(id){
    let ship;try{ship=await SP_RES.getShip(id)}catch(e){VR.flash(e.message);return}
    VR.dialog(`<h2 style="margin:0 0 4px">Deactivate vessel</h2><p style="margin:0 0 14px;color:var(--mute)">${esc(ship.ship_name)} · IMO ${esc(ship.imo_number)}. A deactivated vessel cannot receive new arrival notices.</p>
     <form id="df" novalidate>${VR.fld('reason','Reason (required)','<textarea id="f-reason" maxlength="500" rows="3"></textarea>')}<div class="lmsg bad" id="fmsg" role="alert" hidden></div>
     <div class="stack"><button class="btn pri" type="submit">Deactivate</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
    const f=$('#df');
    f.onsubmit=async e=>{e.preventDefault();const reason=f.querySelector('#f-reason').value.trim();
      if(!reason){VR.showErrors(f,{code:'VALIDATION_FAILED',details:[{field:'reason',message:'Vui lòng nhập lý do vô hiệu hóa.'}]},['reason']);return}
      VR.busy(f,true);
      try{await SP_RES.deactivateShip(ship.id,ship.revision,reason);VR.close();VR.flash('Đã vô hiệu hóa tàu '+ship.ship_name+'.','ok');VR.loadShips()}
      catch(err){VR.busy(f,false,'Deactivate');VR.showErrors(f,err,['reason'])}};
  },

  /* ---------- UC-013 arrival notice, drafts, and the UC-015 result ---------- */
  // The form can start from a saved draft. "Save draft" keeps incomplete data; "Submit notice" saves the notice and the
  // API validates it automatically (no confirmation step). `errs` shows API field errors when a draft failed to submit.
  async openNoticeForm(draft,errs){
    VR.dialog('<h2 style="margin:0 0 14px">Loading…</h2>');
    let ships,agents,ports;try{[ships,agents,ports]=await Promise.all([SP_RES.listShips({size:100}),SP_RES.agents(),SP_RES.ports()])}
    catch(e){VR.dialog(`<h2 style="margin:0 0 8px">Không tải được dữ liệu</h2><p>${esc(e.message)}</p><button class="btn" type="button" data-close>Close</button>`);return}
    if(!ships.items.length){VR.dialog('<h2 style="margin:0 0 8px">Chưa có tàu</h2><p>Chưa có hồ sơ tàu nào đang hoạt động. Hãy tạo hồ sơ tàu trước khi gửi thông báo tàu đến.</p><button class="btn" type="button" data-close>Close</button>');return}
    const p=draft?draft.payload:{};
    const shipOpts=ships.items.map(s=>({id:s.id,name:`${s.ship_name} · IMO ${s.imo_number}`}));
    const prio=VR.can('edit')?VR.fld('priority_class','Priority class',`<select id="f-priority_class">${['STANDARD','MAIN_LINE','REEFER_OR_HAZARD'].map(x=>`<option${p.priority_class===x?' selected':''}>${x}</option>`).join('')}</select>`):'';
    const val=k=>esc(p[k]==null?'':p[k]);
    VR.dialog(`<h2 style="margin:0 0 4px">${draft?'Edit draft':'New arrival notice'}</h2><p style="margin:0 0 14px;color:var(--dim)">Submitting saves the notice and checks it automatically. A draft is private and is not checked. ETA is entered in UTC+7.</p>
     <form id="nf" novalidate><div class="grid2">
      ${VR.fld('ship_id','Vessel',`<select id="f-ship_id">${VR.opts(shipOpts,p.ship_id,'Select…')}</select>`)}
      ${VR.fld('voyage_code','Voyage code',`<input id="f-voyage_code" maxlength="50" autocomplete="off" value="${val('voyage_code')}">`)}
      ${VR.fld('agent_id','Agent',`<select id="f-agent_id">${VR.opts(agents,p.agent_id!=null?p.agent_id:(agents.length===1?agents[0].id:''),'Select…')}</select>`)}
      ${VR.fld('origin_port_id','Origin port',`<select id="f-origin_port_id">${VR.opts(ports,p.origin_port_id,'Select…')}</select>`)}
      ${VR.fld('declared_eta','Declared ETA (UTC+7)',`<input id="f-declared_eta" type="datetime-local" value="${esc(SP_RES_UTIL.isoToLocal(p.declared_eta))}">`)}
      ${VR.fld('declared_teu','TEU',`<input id="f-declared_teu" type="number" min="0" step="1" value="${val('declared_teu')}">`)}
      ${VR.fld('cargo_type','Cargo type',`<input id="f-cargo_type" maxlength="100" value="${val('cargo_type')}">`)}${prio}
     </div>${VR.fld('service_request','Service request (optional)',`<textarea id="f-service_request" maxlength="1000" rows="2">${val('service_request')}</textarea>`)}
     <div class="lmsg bad" id="fmsg" role="alert" hidden></div>
     <div class="stack"><button class="btn pri" type="submit">Submit notice</button><button class="btn" type="button" id="saveDraft">Save draft</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
    const f=$('#nf');
    const gather=()=>{const g=id=>{const el=f.querySelector('#f-'+id);return el?el.value:''};const id=x=>g(x)===''?null:Number(g(x));
      const body={ship_id:id('ship_id'),voyage_code:g('voyage_code').trim(),agent_id:id('agent_id'),origin_port_id:id('origin_port_id'),declared_eta:SP_RES_UTIL.localToIso(g('declared_eta')),
        declared_teu:g('declared_teu')===''?null:Number(g('declared_teu')),cargo_type:g('cargo_type').trim()};
      const sr=VR.blank(g('service_request'));if(sr)body.service_request=sr;if(f.querySelector('#f-priority_class'))body.priority_class=g('priority_class');return body};
    const finish=err=>{VR.busy(f,false,'Submit notice');f.querySelector('#saveDraft').disabled=false;
      if(err.status===409&&err.details&&err.details.rule==='DUPLICATE_NOTICE')err.details={...err.details,field:'voyage_code',message:`Thông báo cho tàu và chuyến này đã tồn tại (mã #${err.details.existing_voyage_id}).`};
      else if(err.details&&err.details.field==='ship_id')err.details={...err.details,message:err.message};
      VR.showErrors(f,err,NOTICE_FIELDS)};
    f.onsubmit=async e=>{e.preventDefault();const body=gather();VR.busy(f,true);f.querySelector('#saveDraft').disabled=true;
      try{let r;
        if(draft){await SP_RES.updateDraft(draft.id,draft.revision,VR.draftBody(body));r=await SP_RES.submitDraft(draft.id)} else r=await SP_RES.createVoyage(body);
        VR.showResult(r);VR.reloadWorkflow()}
      catch(err){finish(err)}};
    $('#saveDraft').onclick=async()=>{const body=VR.draftBody(gather());VR.clearErrors(f);
      if(!Object.keys(body).length){VR.showErrors(f,{code:'LOCAL',message:'Bản nháp trống. Hãy nhập ít nhất một trường.'},NOTICE_FIELDS);return}
      VR.busy(f,true);f.querySelector('#saveDraft').disabled=true;
      try{draft?await SP_RES.updateDraft(draft.id,draft.revision,body):await SP_RES.createDraft(body);VR.close();VR.flash('Đã lưu bản nháp. Bản nháp chưa được gửi và chưa được kiểm tra.','ok');VR.loadDrafts()}
      catch(err){if(err.status===409&&err.details&&err.details.current_revision!==undefined)err.message='Bản nháp vừa được thay đổi ở nơi khác. Vui lòng đóng và mở lại bản nháp.';finish(err)}};
    if(errs)VR.showErrors(f,errs,NOTICE_FIELDS);
  },
  // A draft keeps only what the user filled in.
  draftBody(body){const out={};Object.entries(body).forEach(([k,v])=>{if(v!==null&&v!==''&&!(typeof v==='number'&&Number.isNaN(v)))out[k]=v});return out},

  // Shows the outcome of the automatic validation (UC-015), including the AI label and the queue position.
  showResult(v){
    const r=v.validation||{};
    const body=r.state==='NOT_RUN'
      ?`<p class="lmsg warn">Thông báo đã được lưu (trạng thái ${esc(v.status)}) nhưng kiểm tra tự động chưa chạy: ${esc(r.message)} <small>(${esc(r.code)})</small>. Có thể bấm "Validate again" để thử lại.</p>`
      :`<p><span class="pill ${PILL[v.status]||'mute'}">${esc(v.status)}</span> ${v.queue_position?`<b>Vị trí hàng đợi #${esc(v.queue_position)}</b>`:''}</p>
        ${r.reason?`<p>${esc(r.reason)}</p>`:''}
        ${r.ai?`<h3 style="margin:12px 0 4px;font-size:14px">Dự báo ETA (UC-016)</h3>${r.ai.status==='PENDING'?'<p class="lmsg" style="margin:0 0 6px">Thông báo đã được nhận và vào hàng đợi theo <b>ETA khai báo</b>. Dự báo AI đang chạy riêng; nếu có dự báo hợp lệ, ETA hiệu lực và thứ tự hàng đợi sẽ tự cập nhật.</p>':''}<div id="vEtaResult">${VR.etaBlock(r.ai)}</div><p class="sub" id="vQueuePos" style="margin:6px 0 0;color:var(--mute)"></p>`:''}
        <p class="sub" style="color:var(--dim)">Chính sách ${esc(r.policy_version)}${r.replayed?' · kết quả đã có từ trước, không chạy lại':''}</p>`;
    VR.dialog(`<div id="vresult" data-voyage="${esc(v.id)}"><h2 style="margin:0 0 4px">Automatic validation</h2><p style="margin:0 0 12px;color:var(--dim)">${esc(v.voyage_code)} · ${esc(v.ship_name)}</p>${body}
      <div class="stack">${v.status==='MISSING_DOCUMENTS'||v.status==='ANNOUNCED'?`<button class="btn" type="button" data-act="revalidate" data-id="${v.id}">Validate again</button>`:''}<button class="btn pri" type="button" data-close>Close</button></div></div>`);
  },

  /* ---------- UC-016: declared ETA, predicted ETA, deviation and confidence side by side; prediction history ---------- */
  // Only what the system stored is shown. Without a real forecast the cells say "chưa có dự báo AI" and nothing is invented. Times are UTC+7.
  etaBlock(p){
    if(!p)return '<p class="sub" style="color:var(--dim)">Chưa có bản ghi dự báo cho chuyến này.</p>';
    const t=SP_RES_UTIL.formatUtc7,none='<span style="color:var(--dim)">—</span>';
    const ok=p.status==='AVAILABLE',pend=p.status==='PENDING';
    const dev=ok&&p.deviation_h!=null?`${p.deviation_h>0?'+':''}${Math.round(p.deviation_h*100)/100} giờ`:none;
    const conf=ok&&p.confidence!=null?`<span class="mono">${esc(p.confidence)}</span> <small title="${esc(p.confidence_meaning)}" style="color:var(--dim)">do nhà cung cấp báo; ý nghĩa chưa được định nghĩa</small>`:none;
    return `<table class="eta4" data-eta-status="${esc(p.status)}"><tbody>
      <tr><th scope="row">ETA khai báo (UTC+7)</th><td class="mono num" data-eta="declared">${esc(t(p.declared_eta)||'—')}</td></tr>
      <tr><th scope="row">ETA dự báo (UTC+7)</th><td class="mono num" data-eta="predicted">${ok?esc(t(p.predicted_eta)):pend?`<span class="pill info">${esc(p.label)}…</span>`:`<span class="pill mute">${esc(p.label)}</span> <small style="color:var(--dim)">${esc(p.reason||'')}</small>`}</td></tr>
      <tr><th scope="row">Độ lệch (dự báo trừ khai báo)</th><td class="mono num" data-eta="deviation">${dev}</td></tr>
      <tr><th scope="row">Độ tin cậy</th><td data-eta="confidence">${conf}</td></tr></tbody></table>
      <p class="sub" style="margin:4px 0 0;color:var(--dim)">${ok?`Nguồn: dịch vụ AI ngoài, mô hình ${esc(p.model_version)}`:pend?'Nguồn: đang chờ nhà cung cấp; chuyến đã vào hàng đợi theo ETA khai báo':'Nguồn: không có (chưa cấu hình hoặc không phản hồi); chuyến dùng ETA khai báo'} · lần ${esc(p.sequence==null?'—':p.sequence)} · ${esc(t(p.requested_at)||'—')}</p>${p.queue_effect?`<p class="lmsg ${p.queue_effect==='REORDERED'?'ok':''}" data-queue-effect="${esc(p.queue_effect)}" style="margin:6px 0 0">${esc(VR.EFFECT[p.queue_effect]||p.queue_effect)}</p>`:''}`;
  },
  EFFECT:{REORDERED:'Hàng đợi đã được sắp xếp lại theo ETA dự báo.',UNCHANGED:'Vị trí trong hàng đợi không đổi.',NOT_APPLIED_LEFT_QUEUE:'Chuyến đã rời hàng đợi; dự báo chỉ được lưu, không áp dụng.',NOT_APPLIED_SUPERSEDED:'Đã có dự báo mới hơn; dự báo này không áp dụng.',KEPT_MANUAL_POSITION:'Điều phối viên đã chuyển chuyến này bằng tay; giữ nguyên vị trí.'},
  // A hint says the effective ETA or the queue changed: refresh the forecast shown in an open result or lifecycle dialog.
  async refreshEtaViews(){
    const r=$('#vresult[data-voyage]'),l=$('#vlife[data-voyage]');
    const id=r?r.dataset.voyage:l?l.dataset.voyage:null;if(!id)return;
    try{
      const h=await SP_RES.etaPredictions(id),latest=h.items[0]||null;
      if(r&&$('#vEtaResult'))$('#vEtaResult').innerHTML=VR.etaBlock(latest);
      if(l&&$('#vEta')){$('#vEta').innerHTML=VR.etaBlock(latest);$('#vEtaHist').innerHTML=VR.etaHistory(h.items)}
      if(r&&latest&&latest.status!=='PENDING'){const v=await SP_RES.getVoyage(id);const q=$('#vQueuePos');if(q)q.textContent=v.queue_position?`Vị trí hàng đợi hiện tại: #${v.queue_position}`:'Chuyến không còn trong hàng đợi chờ cập bến'}
    }catch(e){/* the dialog keeps what it shows */}
  },
  etaHistory(items){
    if(!items||!items.length)return '<p class="sub" style="color:var(--dim)">Chưa có lần dự báo nào.</p>';
    const t=SP_RES_UTIL.formatUtc7;
    return `<div class="tw"><table class="eta-hist"><thead><tr><th>Lần</th><th>Thời điểm (UTC+7)</th><th>Nguồn</th><th>Trạng thái</th><th>ETA khai báo</th><th>ETA dự báo</th><th>Độ lệch (giờ)</th><th>Độ tin cậy</th><th>Hàng đợi</th></tr></thead><tbody>${items.map(p=>`<tr data-pred="${esc(p.id)}">
      <td class="num">${esc(p.sequence)}</td><td class="mono num">${esc(t(p.requested_at))}</td><td>${p.status==='AVAILABLE'?esc(p.source.model_version):esc(p.reason||'—')}</td>
      <td><span class="pill ${p.status==='AVAILABLE'?'ok':p.status==='PENDING'?'info':'mute'}">${p.status==='AVAILABLE'?'AVAILABLE':esc(p.label)}</span></td><td class="mono num">${esc(t(p.declared_eta))}</td>
      <td class="mono num">${p.status==='AVAILABLE'?esc(t(p.predicted_eta)):'—'}</td><td class="mono num">${p.status==='AVAILABLE'&&p.deviation_h!=null?esc(p.deviation_h):'—'}</td><td class="mono num">${p.status==='AVAILABLE'&&p.confidence!=null?esc(p.confidence):'—'}</td><td>${p.queue_effect?esc(VR.EFFECT[p.queue_effect]||p.queue_effect):'—'}</td></tr>`).join('')}</tbody></table></div>`;
  },

  async revalidate(id){
    try{const v=await SP_RES.validateVoyage(id);VR.showResult(v);VR.reloadWorkflow()}
    catch(err){VR.flash(err.message)}
  },

  async draftAction(act,id){
    const d=(VR.s.drafts||[]).find(x=>String(x.id)===String(id));if(!d)return;
    if(act==='draft-edit')return VR.openNoticeForm(d);
    if(act==='draft-discard'){try{await SP_RES.discardDraft(d.id,d.revision);VR.flash('Đã hủy bản nháp.','ok');VR.loadDrafts()}catch(err){VR.flash(err.message)}return}
    try{const r=await SP_RES.submitDraft(d.id);VR.showResult(r);VR.reloadWorkflow()} // submit
    catch(err){if(err.code==='VALIDATION_FAILED')VR.openNoticeForm(d,err);else VR.flash(err.message)}
  },

  /* ---------- UC-020 queue ---------- */
  openMove(id){
    const q=VR.s.queue,e=q.items.find(x=>String(x.voyage_id)===String(id));if(!e)return;
    VR.dialog(`<h2 style="margin:0 0 4px">Move in queue</h2><p style="margin:0 0 14px;color:var(--mute)">${esc(e.ship_name)} · ${esc(e.voyage_code)} · now #${esc(e.position)} of ${q.items.length}. A reason is required.</p>
     <form id="qf" novalidate>${VR.fld('to_position','New position',`<input id="f-to_position" type="number" min="1" max="${q.items.length}" step="1" value="${esc(e.position)}">`)}
      ${VR.fld('reason','Reason (required)','<textarea id="f-reason" maxlength="500" rows="3"></textarea>')}<div class="lmsg bad" id="fmsg" role="alert" hidden></div>
     <div class="stack"><button class="btn pri" type="submit">Move</button><button class="btn" type="button" data-close>Cancel</button></div></form>`);
    const f=$('#qf');
    f.onsubmit=async ev=>{ev.preventDefault();
      const to=f.querySelector('#f-to_position').value,reason=f.querySelector('#f-reason').value;
      VR.busy(f,true);
      try{const r=await SP_RES.moveQueue(e.voyage_id,q.revision,{to_position:to===''?null:Number(to),reason});VR.s.queue=r;$('#queueList').innerHTML=VR.queueTable(r);VR.close();VR.flash(`Đã chuyển ${e.voyage_code} tới vị trí ${to}.`,'ok')}
      catch(err){VR.busy(f,false,'Move');
        if(err.status===409&&err.details&&err.details.rule==='QUEUE_CHANGED'){VR.close();VR.flash('Hàng đợi vừa được người khác thay đổi. Danh sách đã được tải lại; vui lòng thử lại.');VR.loadQueue();return}
        VR.showErrors(f,err,['to_position','reason'])}};
  },

  /* ---------- UC-021 schedule: list and Gantt ---------- */
  STATUS_LABEL: { ANNOUNCED: 'Announced', MISSING_DOCUMENTS: 'Missing documents', REJECTED: 'Rejected', VALIDATED: 'Validated', WAITING_BERTH: 'Waiting for berth', BERTH_ASSIGNED: 'Berth assigned', BERTHED: 'Berthed', DEPARTED: 'Departed' },
  schedulePanel() {
    return `<section class="panel" id="sch"><div class="ph"><div><h2>Lịch tàu · Vessel schedule</h2><div class="sub">List and Gantt by day or week · live data · times in UTC+7. Berth comes from the approved berth plan (Module 2).</div></div></div>
    <div class="tabs" role="tablist"><button type="button" role="tab" data-sv="list" aria-selected="true">List</button><button type="button" role="tab" data-sv="gantt" aria-selected="false">Gantt</button></div>
    <div class="filters" style="padding:12px 16px;gap:10px;flex-wrap:wrap">
      <label>Status <select id="schStatus" aria-label="Filter by status"><option value="">All</option>${Object.entries(VR.STATUS_LABEL).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
      <label>Agent <select id="schAgent" aria-label="Filter by agent"><option value="">All</option></select></label>
      <label>Berth <select id="schBerth" aria-label="Filter by berth"><option value="">All</option></select></label>
      <span id="schRange" hidden>
        <button type="button" class="btn" data-sw="day" aria-pressed="true">Day</button><button type="button" class="btn" data-sw="week" aria-pressed="false">Week</button>
        <button type="button" class="btn" data-sd="-1" aria-label="Previous">‹</button><input type="date" id="schDate" aria-label="Date"><button type="button" class="btn" data-sd="1" aria-label="Next">›</button>
        <button type="button" class="btn" data-sd="0">Today</button></span>
    </div><div id="schBody" aria-live="polite"></div></section>`;
  },
  async loadScheduleFilters() {
    try {
      const [agents, berths] = await Promise.all([SP_RES.agents(), SP_RES.berths()]);
      $('#schAgent').insertAdjacentHTML('beforeend', agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join(''));
      $('#schBerth').insertAdjacentHTML('beforeend', berths.map((b) => `<option value="${b.id}">${esc(b.code)} · ${esc(b.name)}</option>`).join(''));
    } catch (e) { VR.flash('Không tải được bộ lọc lịch tàu: ' + e.message); }
  },
  scheduleParams() {
    const c = VR.s.sch;
    const p = { status: c.status, agent_id: c.agent, berth_id: c.berth };
    if (c.view === 'gantt') { const w = SP_RES_UTIL.scheduleWindow(c.date, c.mode); c.win = w; p.view = 'gantt'; p.from = w.from; p.to = w.to; }
    else { p.view = 'list'; p.page = c.page; p.size = 10; }
    return p;
  },
  async loadSchedule({ silent } = {}) {
    const box = $('#schBody'); const c = VR.s.sch;
    $('#schRange').hidden = c.view !== 'gantt';
    $('#schDate').value = c.date;
    if (!silent) box.innerHTML = VR.stateBox('loading', 'Loading…');
    const seq = (c.seq = (c.seq || 0) + 1); // a slow answer for an older filter must not overwrite a newer one
    try {
      const d = await SP_RES.schedule(VR.scheduleParams());
      if (seq !== c.seq) return;
      const sig = JSON.stringify([c.view, c.win, d.items, d.total]);
      if (silent && c.sig === sig && box.innerHTML) return;
      c.sig = sig;
      box.innerHTML = c.view === 'gantt' ? VR.ganttHtml(d) : VR.scheduleList(d);
    } catch (e) { if (seq === c.seq && !silent) box.innerHTML = VR.stateBox('error', 'Không tải được lịch tàu', e.message, 'schedule'); }
  },
  scheduleList(d) {
    if (!d.items.length) return VR.stateBox('empty', 'Không có dữ liệu', 'Không có chuyến tàu nào khớp bộ lọc.');
    const t = SP_RES_UTIL.formatUtc7;
    return `<div class="tw"><table><thead><tr><th>Vessel / voyage</th><th>Status</th><th>Agent</th><th>Berth</th><th>ETA</th><th>ATA</th><th>ATD</th></tr></thead><tbody>${d.items.map((v) => `<tr data-sched="${v.id}">
      <td><button type="button" class="linkbtn" data-act="lifecycle" data-id="${v.id}">${esc(v.ship_name)}</button><br><small class="mono" style="color:var(--dim);font-size:10px">${esc(v.voyage_code)} · IMO ${esc(v.imo_number)}</small></td>
      <td><span class="pill ${PILL[v.status] || 'mute'}">${esc(v.status)}</span></td><td>${esc(v.agent_name)}</td>
      <td>${v.berth_code ? esc(v.berth_code) : '<span style="color:var(--dim)">—</span>'}</td>
      <td class="mono num">${esc(t(v.declared_eta))}</td><td class="mono num">${esc(t(v.ata) || '—')}</td><td class="mono num">${esc(t(v.atd) || '—')}</td></tr>`).join('')}</tbody></table></div>${VR.paging(d.total, d.page, d.size, 'sched')}`;
  },
  ganttHtml(d) {
    const c = VR.s.sch; const w = c.win; const U = SP_RES_UTIL;
    if (!d.items.length) return VR.stateBox('empty', 'Không có dữ liệu', 'Không có chuyến tàu nào trong khung thời gian và bộ lọc này.');
    const lanes = new Map();
    for (const it of d.items) { const k = it.berth_id || 0; if (!lanes.has(k)) lanes.set(k, { code: it.berth_code, name: it.berth_name, items: [] }); lanes.get(k).items.push(it); }
    const ordered = [...lanes.entries()].sort((a, b) => (a[0] === 0) - (b[0] === 0) || String(a[1].code).localeCompare(String(b[1].code)));
    const cols = w.days === 1 ? 8 : 7;
    const ticks = Array.from({ length: cols }, (_, i) => w.days === 1
      ? `<span style="left:${i / cols * 100}%">${String(i * 3).padStart(2, '0')}:00</span>`
      : `<span style="left:${(i + 0.5) / cols * 100}%">${esc(U.shiftDate(w.firstDate, i).slice(5).split('-').reverse().join('/'))}</span>`).join('');
    const ROW = 38.5;
    const lane = ([key, l]) => {
      const { placed, rows } = U.packRows(l.items);
      const bars = placed.map(({ item: v, row }) => {
        const g = U.barGeometry(v, w.from, w.to, 0.01);
        const cls = g.marker ? 'st-eta' : v.status === 'DEPARTED' ? 'st-dep' : v.bar_source === 'ACTUAL' ? 'st-ber' : 'st-sch';
        const when = g.marker ? 'ETA ' + U.formatUtc7(v.declared_eta) : U.formatUtc7(v.start_at) + ' → ' + (U.formatUtc7(v.end_at) || '…');
        const style = `left:${g.left * 100}%;top:${row * ROW + 6}px;` + (g.marker ? 'width:16px;padding:0' : `width:${g.width * 100}%`);
        return `<button type="button" class="blk ${cls}" data-act="lifecycle" data-id="${v.id}" style="${style}" title="${esc(v.ship_name + ' · ' + v.voyage_code + ' · ' + v.status + ' · ' + when)}"><span>${g.marker ? '' : esc(v.ship_name)}</span>${g.marker ? '' : `<small>${esc(v.voyage_code)}</small>`}</button>`;
      }).join('');
      return `<div class="tlr" data-lane="${key}" style="height:${rows * ROW}px"><div class="t">${key === 0 ? 'Chưa xếp bến' : esc(l.code)}<small>${key === 0 ? 'no approved plan · ETA only' : esc(l.name)}</small></div><div class="lane" style="background-size:calc(100%/${cols}) 100%">${bars}</div></div>`;
    };
    const now = Date.now(); const f = new Date(w.from).getTime(); const span = new Date(w.to).getTime() - f;
    const nowLine = now >= f && now < f + span ? `<div style="position:absolute;left:96px;right:0;top:30px;bottom:0;pointer-events:none"><div class="nowl" style="left:${(now - f) / span * 100}%"></div></div>` : '';
    const warn = d.truncated ? `<p class="lmsg warn" style="margin:12px 16px 0">Chỉ hiển thị ${d.items.length} / ${d.total} chuyến. Hãy thu hẹp bộ lọc hoặc khung thời gian.</p>` : '';
    return `${warn}<div class="tl"><div class="tlin" style="position:relative;min-width:${w.days === 1 ? 640 : 760}px"><div class="tlh"><div>BERTH</div><div class="ax">${ticks}</div></div>${ordered.map(lane).join('')}${nowLine}</div></div>
      <div class="sw"><span><i style="border-color:var(--ok)"></i>Departed (ATA–ATD)</span><span><i style="border-color:var(--accent)"></i>Berthed (ATA–plan end)</span><span><i style="border-color:var(--line2)"></i>Planned</span><span><i style="border-color:var(--line2);border-style:dashed"></i>ETA only, no berth plan</span><span class="r">${esc(U.formatUtc7(w.from).slice(0, 10))} → ${esc(U.formatUtc7(new Date(f + span - 60000).toISOString()).slice(0, 10))} · UTC+7</span></div>`;
  },
  async openLifecycle(id) {
    let v, hist = { items: [] }; try { v = await SP_RES.getVoyage(id); } catch (e) { VR.flash(e.message); return; }
    try { hist = await SP_RES.etaPredictions(id); } catch (e) { hist = null; }   // the history is secondary: its failure does not hide the lifecycle
    const t = SP_RES_UTIL.formatUtc7;
    VR.dialog(`<div id="vlife" data-voyage="${esc(v.id)}"><h2 style="margin:0 0 4px">${esc(v.ship_name)}</h2><p style="margin:0 0 12px;color:var(--dim)">${esc(v.voyage_code)} · IMO ${esc(v.imo_number)} · <span class="pill ${PILL[v.status] || 'mute'}">${esc(v.status)}</span></p>
      <dl class="dtl" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 18px"><dt>Agent</dt><dd>${esc(v.agent_name)}</dd><dt>ETA</dt><dd>${esc(t(v.declared_eta))}</dd><dt>ATA</dt><dd>${esc(t(v.ata) || '—')}</dd><dt>ATD</dt><dd>${esc(t(v.atd) || '—')}</dd></dl>
      <h3 style="margin:16px 0 6px;font-size:14px">Dự báo ETA</h3><div id="vEta">${VR.etaBlock(v.eta)}</div>
      <h3 style="margin:16px 0 6px;font-size:14px">Lịch sử dự báo ETA</h3><div id="vEtaHist">${hist ? VR.etaHistory(hist.items) : '<p class="lmsg warn">Không tải được lịch sử dự báo.</p>'}</div>
      <h3 style="margin:16px 0 6px;font-size:14px">Lifecycle</h3><ol class="hist">${(v.history || []).map((h) => `<li><b>${esc(h.to_status)}</b>${h.from_status ? ' ← ' + esc(h.from_status) : ''} · ${esc(t(h.changed_at))} · ${esc(h.actor)}${h.reason ? ' — ' + esc(h.reason) : ''}</li>`).join('') || '<li>—</li>'}</ol>
      <div class="stack">${VR.can('edit') && v.status === 'BERTH_ASSIGNED' ? `<button class="btn pri" type="button" data-act="berthing" data-id="${v.id}">Xác nhận cập bến</button>` : ''}${VR.can('edit') && v.status === 'BERTHED' ? `<button class="btn pri" type="button" data-act="departure" data-id="${v.id}">Xác nhận rời bến</button>` : ''}<button class="btn" type="button" data-close>Close</button></div></div>`);
  },

  /* ---------- UC-022 / UC-023: actual berthing and departure ---------- */
  // The time defaults to now. It is sent only when the coordinator changed it (an edit then needs a reason, enforced by the API too).
  async openMovement(id, kind) {
    let v, berthName = null, berths = [];
    try {
      v = await SP_RES.getVoyage(id);
      if (kind === 'berthing') {
        const [plans, list] = await Promise.all([SP_RES.listPlans({ status: 'APPROVED', voyage_id: id }), SP_RES.berths()]);
        berths = list;
        berthName = plans.items[0] ? plans.items[0].berth_id : null;
      }
    } catch (e) { VR.flash(e.message); return; }
    const berthing = kind === 'berthing';
    const pad = (n) => String(n).padStart(2, '0'), d = new Date();
    const initial = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    VR.dialog(`<h2 style="margin:0 0 4px">${berthing ? 'Xác nhận cập bến' : 'Xác nhận rời bến'}</h2><p style="margin:0 0 14px;color:var(--mute)">${esc(v.ship_name)} · ${esc(v.voyage_code)}</p>
      <form id="mvf" novalidate>
       ${berthing ? VR.fld('berth_id', 'Bến tàu thực tế cập vào', `<select id="f-berth_id">${berths.map((b) => `<option value="${b.id}"${b.id === berthName ? ' selected' : ''}>${esc(b.code)} · ${esc(b.name)}</option>`).join('')}</select>`) : ''}
       ${VR.fld('actual_time', berthing ? 'Giờ cập bến thực tế (ATA)' : 'Giờ rời bến thực tế (ATD)', `<input id="f-actual_time" type="datetime-local" value="${initial}">`)}
       ${VR.fld('reason', 'Lý do (bắt buộc nếu sửa giờ)', '<textarea id="f-reason" maxlength="500" rows="2"></textarea>')}
       <div class="lmsg bad" id="fmsg" role="alert" hidden></div>
       <div class="stack"><button class="btn pri" type="submit" id="mvConfirm">Xác nhận</button><button class="btn" type="button" data-close>Hủy</button></div></form>`);
    const f = $('#mvf');
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const body = {}, t = f.querySelector('#f-actual_time').value, reason = f.querySelector('#f-reason').value.trim();
      if (berthing) body.berth_id = Number(f.querySelector('#f-berth_id').value);
      if (t && t !== initial) body.actual_time = new Date(t).toISOString();
      if (reason) body.reason = reason;
      VR.busy(f, true);
      try {
        const r = await (berthing ? SP_RES.confirmBerthing : SP_RES.confirmDeparture)(id, v.revision, body);
        VR.close(); VR.flash(`${berthing ? 'Đã xác nhận cập bến' : 'Đã xác nhận rời bến'}: ${r.voyage_code}.`, 'ok'); VR.loadSchedule();
      } catch (err) {
        VR.busy(f, false, 'Xác nhận');
        if (err.status === 409 && err.details && err.details.current_revision !== undefined) { VR.close(); VR.flash('Chuyến vừa được người khác thay đổi. Danh sách đã được tải lại; vui lòng thử lại.'); VR.loadSchedule(); return; }
        VR.showErrors(f, err, ['berth_id', 'actual_time', 'reason']);
        if (err.status === 409) VR.loadSchedule();
      }
    };
  },
  setSchedule(patch) { Object.assign(VR.s.sch, patch); VR.loadSchedule(); },

  /* ---------- wiring ---------- */
  bind(){
    const add=$('#addShip'),addN=$('#addNotice');
    add.hidden=!VR.can('edit');addN.hidden=!VR.can('notice');
    add.onclick=()=>VR.openShipForm(null);addN.onclick=()=>VR.openNoticeForm(null);
    $('#shipQ').oninput=e=>{clearTimeout(VR.s.timer);VR.s.timer=setTimeout(()=>{VR.s.search=e.target.value.trim();VR.s.shipPage=0;VR.loadShips()},300)};
    $('#shipInactive').onchange=e=>{VR.s.inactive=e.target.checked;VR.s.shipPage=0;VR.loadShips()};
    document.addEventListener('click',async e=>{const t=e.target.closest('button');if(!t)return;
      if(t.hasAttribute('data-close'))return VR.close();
      const sv=t.dataset.sv;if(sv){document.querySelectorAll('[data-sv]').forEach(b=>b.setAttribute('aria-selected',String(b===t)));return VR.setSchedule({view:sv,page:0})}
      if(t.dataset.sw){document.querySelectorAll('[data-sw]').forEach(b=>b.setAttribute('aria-pressed',String(b===t)));return VR.setSchedule({mode:t.dataset.sw})}
      if(t.dataset.sd!==undefined){const n=Number(t.dataset.sd);return VR.setSchedule({date:n===0?SP_RES_UTIL.todayLocal():SP_RES_UTIL.shiftDate(VR.s.sch.date,n*(VR.s.sch.mode==='week'?7:1))})}
      const r=t.dataset.retry;if(r==='schedule')return VR.loadSchedule();if(r==='ships')return VR.loadShips();if(r==='notices')return VR.loadNotices();if(r==='drafts')return VR.loadDrafts();if(r==='queue')return VR.loadQueue();
      if(t.dataset.pg){const[k,dir]=t.dataset.pg.split(':'),step=dir==='next'?1:-1;if(k==='sched')return VR.setSchedule({page:Math.max(0,VR.s.sch.page+step)});if(k==='ship'){VR.s.shipPage=Math.max(0,VR.s.shipPage+step);VR.loadShips()}else{VR.s.noticePage=Math.max(0,VR.s.noticePage+step);VR.loadNotices()}return}
      const act=t.dataset.act;if(!act)return;
      if(act==='detail'){try{VR.openDetail(await SP_RES.getShip(t.dataset.id))}catch(err){VR.flash(err.message)}return}
      if(act==='edit'){try{VR.openShipForm(await SP_RES.getShip(t.dataset.id))}catch(err){VR.flash(err.message)}return}
      if(act==='deactivate')return VR.openDeactivate(t.dataset.id);
      if(act==='lifecycle')return VR.openLifecycle(t.dataset.id);
      if(act==='berthing'||act==='departure')return VR.openMovement(t.dataset.id,act);
      if(act==='revalidate')return VR.revalidate(t.dataset.id);
      if(act==='move')return VR.openMove(t.dataset.id);
      if(act==='berth-check')return BP.openCheck(t.dataset.id);
      if(act.startsWith('draft-'))return VR.draftAction(act,t.dataset.id)});
    VR.loadShips();VR.loadNotices();VR.loadDrafts();
    if(VR.can('view')){VR.loadQueue();VR.loadScheduleFilters();VR.loadSchedule();
      for(const [id,key] of [['schStatus','status'],['schAgent','agent'],['schBerth','berth']])$('#'+id).onchange=e=>VR.setSchedule({[key]:e.target.value,page:0});
      $('#schDate').onchange=e=>{if(/^\d{4}-\d{2}-\d{2}$/.test(e.target.value))VR.setSchedule({date:e.target.value})}}
    else{$('#que').hidden=true;$('#sch').hidden=true} // agents see only their own notices, not the whole queue
  },
};
