V.vessels=()=>{
 return `<div class="head"><div><h1>Vessel management &amp; berth scheduling</h1><p>Plan vessel calls, allocate berths and resolve schedule conflicts across all terminals in real time.</p></div></div>
<nav class="jump" aria-label="Các phần của trang"><a href="#reg">Đăng ký tàu</a><a href="#sch">Lịch tàu</a><a href="#que">Hàng đợi</a><a href="#nts">Thông báo</a><a href="#brt">Cầu bến</a><a href="#plp">Kế hoạch</a><a href="#ntc">Tàu đến</a><a href="#sample">Dữ liệu mẫu</a></nav>
${VR.registryPanel()}
${VR.schedulePanel()}
${VR.queuePanel()}
${BP.notePanel()}
${BP.panel()}
${BP.planPanel()}
${BC.panel()}
${VR.noticePanel()}
<div id="sample" class="sample" role="group" aria-label="Dữ liệu mẫu"><p class="sample-tag"><b>DỮ LIỆU MẪU · SAMPLE DATA</b> Các chỉ số, cảnh báo và thanh trạng thái dưới đây là số liệu minh họa cố định, không lấy từ hệ thống; chưa có nguồn dữ liệu vận hành. Các phần phía trên là dữ liệu thật.</p>
${kpis([['Vessels at berth','7 / 10','','+1 6 arriving · 4 departing today','up','ship',[4,5,5,6,6,7,6,7,7,7,7,7],'var(--accent)'],['Berth utilization','78','%','+4.2% vs 7-day average','up','anchor',[60,66,64,70,68,74,72,75,76,78,77,78],'var(--accent)'],['Avg. waiting time','2.4',' h','−0.6 h vs 7-day average','up','timer',[4,3.8,3.9,3.4,3.2,3.1,2.9,3,2.7,2.6,2.5,2.4],'var(--accent)'],['Schedule conflicts','2','','1 high Resolve before 12:00','bd','warn',[1,1,2,1,2,2,2,3,2,2,2,2],'var(--bad)']])}
<div class="row2" style="grid-template-columns:minmax(0,1fr)">
 <section class="panel"><div class="ph"><div><h2>Scheduling alerts</h2><div class="sub">Conflicts and delays awaiting a decision</div></div></div><div class="pb"><ul class="list">
 <li><div><b>B4 · Berth window overlap</b><small>COSCO PACIFIC vs ZIM ROTTERDAM · 3 h overlap from 01:00</small></div><span class="pill warn" style="align-self:flex-start">High</span></li>
 <li><div><b>COSCO PACIFIC · ETA slipped</b><small>AIS speed 11.2 kn · Arrival delayed by 2 h</small></div><span class="pill info" style="align-self:flex-start">Watch</span></li>
 <li><div><b>STS-04 · Maintenance window</b><small>B5 blocked 12:00 – 06:00 · 1 vessel affected</small></div><span class="pill mute" style="align-self:flex-start">Info</span></li></ul>
 <div class="stack"><button class="btn pri" type="button" disabled title="Chưa triển khai">Resolve conflicts</button><button class="btn" type="button" disabled title="Chưa triển khai">Export plan</button></div></div></section></div>
<div class="strip"><span>Berth occupancy · <b>7 / 10</b></span><span>Tugs available · <b>5 / 8</b></span><span>Pilots on duty · <b>6</b></span><span>Tide window · <b>OK until 17:40</b></span><span style="margin-left:auto">Mooring crews · <b>2 free</b></span></div>
<div class="foot"><span>Sources: AIS · Terminal operating system · Port authority berth plan · Tide gauge</span><span>NLRTM / SHIFT A / UTC+2</span></div></div>`};

BIND.vessels=()=>{VR.bind();BP.bind();BC.bind()};
SP.mount('vessels');
