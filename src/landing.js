const app = document.getElementById('app');

app.innerHTML = `
  <main class="fable-command" aria-label="COD Fable command home">
    <div class="fable-noise"></div>
    <header class="fable-topbar">
      <a class="fable-mark" href="/" aria-label="COD Fable home"><i></i><span>COD</span> FABLE</a>
      <nav aria-label="Primary navigation">
        <button class="active" type="button">Play</button>
        <button type="button" data-soon="Agents are in the next command update.">Operators</button>
        <button type="button" data-soon="Progression and stats are being built after the core loop.">Career</button>
        <button type="button" data-soon="The loadout bay arrives with multiple weapon roles.">Loadout</button>
      </nav>
      <div class="fable-status"><b></b> Local command <span>v0.1</span></div>
    </header>

    <section class="fable-stage">
      <div class="fable-hero-art" aria-hidden="true">
        <div class="fable-orbit orbit-a"></div><div class="fable-orbit orbit-b"></div><div class="fable-crosshair"></div>
        <svg viewBox="0 0 560 680" class="fable-operator" fill="none">
          <path d="M291 92c49 0 88 40 88 89 0 29-14 55-35 71l25 87 74 37-34 67-88-25-16 92 58 93-88 37-62-100-64 101-85-38 63-95-20-122-70 6-11-73 90-18 30-102c-22-16-36-43-36-73 0-49 39-89 88-89Z" fill="#e6dfcf"/>
          <path d="m201 240 89 47 84-24 83 89-27 32-80-55-91 28-74-56 16-61Z" fill="#ee4e3f"/>
          <path d="m118 323 186 22 190-98 12 28-191 130-205-23 8-59Z" fill="#121b20"/>
          <path d="m110 382 205 23 104 82-31 44-122-61-139-13-17-75Z" fill="#a6bdbe"/>
          <path d="m213 180 50-24 61 20 25 52-56 29-73-20-7-57Z" fill="#17252a"/>
          <circle cx="293" cy="126" r="49" fill="#ee4e3f"/><path d="m270 126 18 19 33-35" stroke="#f6eedf" stroke-width="11" stroke-linecap="square"/>
          <path d="m180 513 31 111m111-119 58 104" stroke="#ee4e3f" stroke-width="12"/>
        </svg>
        <div class="fable-art-label top">UNIT // F-07</div><div class="fable-art-label bottom">PROCEDURAL OPERATOR</div>
      </div>
      <div class="fable-copy">
        <p class="fable-kicker">Market district // live simulation</p>
        <h1>TAKE<br>THE BLOCK.</h1>
        <p class="fable-intro">A code-born tactical sandbox with a live city waiting on the other side of deploy.</p>
        <div class="fable-readout"><span>OPERATION READY</span><b>02:43</b><i>THREAT: ACTIVE</i></div>
        <div class="fable-actions">
          <button class="fable-deploy" data-play="operation" type="button"><span>Deploy</span><small>Garrison operation</small><i>↗</i></button>
          <button class="fable-secondary" data-play="practice" type="button">Practice range <i>→</i></button>
        </div>
      </div>

      <aside class="fable-brief" aria-label="Operation briefing">
        <div class="fable-brief-top"><span>Featured operation</span><b>01 / 03</b></div>
        <div class="fable-map"><i></i><i></i><i></i><strong>GARRISON</strong><span>MARKET SECTOR</span><em>F</em></div>
        <div class="fable-brief-body"><strong>Live-fire patrol</strong><p>Push through the market district against two hostile squads. No matchmaking. Just the simulation.</p></div>
        <div class="fable-brief-meta"><span>SOLO</span><span>6 HOSTILES</span><span>OPEN ENDED</span></div>
      </aside>
    </section>

    <footer class="fable-footer">
      <span><b>●</b> World sleeps until deployment</span>
      <span>WASD / mouse once deployed</span>
      <button type="button" data-performance>Performance profile</button>
    </footer>
    <div class="fable-toast" role="status" aria-live="polite"></div>
  </main>`;

const go = (mode, quality) => {
  const next = new URL(location.href);
  next.search = '';
  next.searchParams.set('play', mode);
  if (quality) next.searchParams.set('q', quality);
  location.assign(next.href);
};

for (const button of app.querySelectorAll('[data-play]')) {
  button.addEventListener('click', () => go(button.dataset.play));
}
app.querySelector('[data-performance]').addEventListener('click', () => go('operation', 'performance'));

const toast = app.querySelector('.fable-toast');
for (const button of app.querySelectorAll('[data-soon]')) {
  button.addEventListener('click', () => {
    toast.textContent = button.dataset.soon;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2600);
  });
}

const style = document.createElement('style');
style.textContent = `
  .fable-command { --ink:#e9e4d8; --muted:#a89f91; --red:#ee4e3f; --paper:#ded8c8; position:relative; isolation:isolate; min-height:100vh; overflow:hidden; color:var(--ink); background:#11181e; font-family:Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif; }
  .fable-command::before { content:""; position:absolute; z-index:-3; inset:0; background:radial-gradient(circle at 72% 38%,rgba(73,126,132,.46),transparent 27%),radial-gradient(circle at 55% 65%,rgba(235,103,58,.22),transparent 23%),linear-gradient(112deg,#121619 0%,#25353c 48%,#101719 100%); }
  .fable-command::after { content:""; position:absolute; z-index:-2; inset:-15%; opacity:.38; background:linear-gradient(125deg,transparent 0 41%,rgba(232,224,204,.12) 41.1% 41.3%,transparent 41.4% 58%,rgba(232,224,204,.1) 58.1% 58.25%,transparent 58.4%),repeating-linear-gradient(90deg,transparent 0 118px,rgba(232,224,204,.035) 119px 120px); transform:skewX(-14deg); }
  .fable-noise { position:absolute; inset:0; z-index:-1; pointer-events:none; opacity:.24; background-image:repeating-radial-gradient(circle at 0 0,rgba(255,255,255,.55) 0 1px,transparent 1px 3px); background-size:5px 5px; mix-blend-mode:soft-light; }
  .fable-topbar { height:76px; display:flex; align-items:center; gap:clamp(1.5rem,5vw,6rem); padding:0 clamp(1.25rem,4vw,5rem); border-bottom:1px solid rgba(233,228,216,.18); background:rgba(8,12,14,.45); }
  .fable-mark { color:var(--ink); text-decoration:none; font-size:1.2rem; letter-spacing:.14em; white-space:nowrap; } .fable-mark span { color:var(--red); } .fable-mark i { display:inline-block; width:13px; height:13px; margin-right:.5rem; background:var(--red); clip-path:polygon(0 0,100% 50%,0 100%,28% 50%); }
  .fable-topbar nav { display:flex; height:100%; gap:clamp(1rem,3vw,3rem); } .fable-topbar nav button { position:relative; border:0; background:none; color:rgba(233,228,216,.54); font:inherit; font-size:.73rem; letter-spacing:.16em; text-transform:uppercase; cursor:pointer; } .fable-topbar nav button:hover,.fable-topbar nav button:focus-visible,.fable-topbar nav .active { color:var(--ink); outline:0; } .fable-topbar nav .active::after { content:""; position:absolute; left:0; right:0; bottom:0; height:3px; background:var(--red); }
  .fable-status { margin-left:auto; color:var(--muted); font:600 .62rem/1.2 ui-monospace,SFMono-Regular,monospace; letter-spacing:.08em; text-transform:uppercase; white-space:nowrap; } .fable-status b { display:inline-block; width:7px; height:7px; margin-right:.5rem; border-radius:50%; background:#a6dc93; box-shadow:0 0 12px #a6dc93; } .fable-status span { margin-left:.7rem; color:rgba(233,228,216,.5); }
  .fable-stage { min-height:calc(100vh - 136px); display:grid; grid-template-columns:minmax(20rem,1fr) minmax(18rem,.62fr); align-items:center; gap:clamp(2rem,8vw,10rem); padding:clamp(2.5rem,8vw,9rem) clamp(1.25rem,9vw,11rem) 4rem; }
  .fable-copy { max-width:42rem; } .fable-kicker { margin:0 0 1rem; color:#eeb37e; font:600 .68rem/1.2 ui-monospace,SFMono-Regular,monospace; letter-spacing:.2em; text-transform:uppercase; } .fable-copy h1 { margin:0; color:#f0e9db; font-size:clamp(4.8rem,10vw,10.5rem); font-weight:900; line-height:.78; letter-spacing:-.05em; text-shadow:0 8px 45px rgba(0,0,0,.25); } .fable-intro { max-width:27rem; margin:2rem 0; color:rgba(233,228,216,.72); font:400 clamp(.85rem,1.1vw,1rem)/1.6 Arial,sans-serif; }
  .fable-actions { display:flex; align-items:center; flex-wrap:wrap; gap:1rem; } .fable-deploy { min-width:222px; display:grid; grid-template-columns:1fr auto; gap:0 .8rem; padding:1rem 1.1rem; border:1px solid #f47d57; color:#1b1714; background:var(--red); text-align:left; cursor:pointer; transition:transform .18s ease,background .18s ease; } .fable-deploy:hover,.fable-deploy:focus-visible { background:#ff7768; transform:translateY(-3px); outline:2px solid #fff1dc; outline-offset:3px; } .fable-deploy span { font:900 1.5rem/1 Impact,Haettenschweiler,sans-serif; letter-spacing:.08em; text-transform:uppercase; } .fable-deploy small { grid-column:1; font:600 .56rem/1.3 Arial,sans-serif; letter-spacing:.1em; text-transform:uppercase; } .fable-deploy i { grid-row:1/3; grid-column:2; align-self:center; font-size:1.5rem; font-style:normal; }
  .fable-secondary { border:0; color:var(--ink); background:transparent; font:inherit; font-size:.78rem; letter-spacing:.13em; text-transform:uppercase; cursor:pointer; } .fable-secondary:hover,.fable-secondary:focus-visible { color:#f1a274; outline:0; } .fable-secondary i { margin-left:.7rem; font-style:normal; }
  .fable-brief { align-self:center; border:1px solid rgba(233,228,216,.33); background:rgba(10,15,17,.49); backdrop-filter:blur(8px); box-shadow:20px 24px 0 rgba(4,7,8,.16); } .fable-brief-top,.fable-brief-meta { display:flex; justify-content:space-between; padding:.85rem 1rem; color:rgba(233,228,216,.67); font:600 .58rem/1 ui-monospace,SFMono-Regular,monospace; letter-spacing:.14em; text-transform:uppercase; } .fable-brief-top b { color:#f0b474; font-weight:600; } .fable-map { position:relative; min-height:230px; display:grid; place-content:center; overflow:hidden; background:linear-gradient(145deg,#263a3c,#15242a); border-top:1px solid rgba(233,228,216,.12); border-bottom:1px solid rgba(233,228,216,.12); } .fable-map::before { content:""; position:absolute; inset:12%; border:1px solid rgba(233,228,216,.23); transform:rotate(45deg) scale(.78); } .fable-map i { position:absolute; width:14px; height:14px; border:2px solid #eea861; transform:rotate(45deg); } .fable-map i:nth-child(1){top:27%;left:27%}.fable-map i:nth-child(2){right:22%;top:43%;border-color:#d6e8e2}.fable-map i:nth-child(3){bottom:22%;left:48%;border-color:var(--red)} .fable-map strong { position:relative; color:#f1eade; font-size:2.4rem; letter-spacing:.08em; } .fable-map span { position:relative; color:#dfad75; text-align:center; font:600 .56rem/1.5 ui-monospace,SFMono-Regular,monospace; letter-spacing:.16em; }
  .fable-brief-body { padding:1.2rem 1rem; } .fable-brief-body strong { font-size:1.05rem; letter-spacing:.09em; text-transform:uppercase; } .fable-brief-body p { margin:.6rem 0 0; color:rgba(233,228,216,.62); font:400 .75rem/1.5 Arial,sans-serif; } .fable-brief-meta { border-top:1px solid rgba(233,228,216,.12); color:#d9aa70; }
  .fable-footer { min-height:60px; display:flex; align-items:center; gap:2rem; padding:0 clamp(1.25rem,4vw,5rem); border-top:1px solid rgba(233,228,216,.14); color:rgba(233,228,216,.52); font:600 .58rem/1 ui-monospace,SFMono-Regular,monospace; letter-spacing:.1em; text-transform:uppercase; } .fable-footer b { color:#a6dc93; } .fable-footer span:nth-child(2){margin-left:auto}.fable-footer button { border:0; color:#e4b17a; background:none; font:inherit; font-size:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; }.fable-footer button:hover,.fable-footer button:focus-visible{color:#fff;outline:0;text-decoration:underline;text-underline-offset:.35rem}
  .fable-toast { position:fixed; right:2rem; bottom:5.4rem; max-width:18rem; padding:.8rem 1rem; opacity:0; transform:translateY(.5rem); color:#201d19; background:#e8ddca; font:600 .68rem/1.4 Arial,sans-serif; transition:opacity .2s,transform .2s; pointer-events:none; }.fable-toast.show{opacity:1;transform:none}
  @media(max-width:800px){.fable-topbar{height:60px;gap:1rem}.fable-topbar nav{gap:1rem}.fable-topbar nav button:not(.active){display:none}.fable-status{font-size:.52rem}.fable-stage{grid-template-columns:1fr;padding:4rem 1.5rem 3rem}.fable-brief{max-width:28rem}.fable-footer{gap:1rem;padding:0 1.5rem}.fable-footer span:nth-child(2){display:none}.fable-footer button{margin-left:auto}}
  @media(prefers-reduced-motion:reduce){.fable-deploy,.fable-toast{transition:none}}

  /* Deliberately asymmetric key-art treatment: an operator constructed from
     inline geometry, not a stock image, so first paint stays instant. */
  .fable-stage { position:relative; }
  .fable-hero-art { position:absolute; inset:4% 19% 2% 29%; pointer-events:none; overflow:hidden; opacity:.92; }
  .fable-operator { position:absolute; width:min(58vw,620px); height:auto; right:3%; bottom:-9%; filter:drop-shadow(0 26px 28px rgba(0,0,0,.45)); transform:rotate(-4deg); }
  .fable-orbit { position:absolute; border:1px solid rgba(238,78,63,.65); border-radius:50%; transform:rotate(-27deg); }.orbit-a{width:41vw;height:41vw;max-width:560px;max-height:560px;right:6%;bottom:7%;}.orbit-b{width:28vw;height:28vw;max-width:390px;max-height:390px;right:20%;bottom:25%;border-color:rgba(224,216,200,.22);}
  .fable-crosshair { position:absolute; right:4%; top:19%; width:140px; height:140px; border:1px solid rgba(230,223,207,.2); transform:rotate(45deg); }.fable-crosshair::before,.fable-crosshair::after{content:"";position:absolute;background:rgba(230,223,207,.32)}.fable-crosshair::before{width:1px;top:-24px;bottom:-24px;left:50%}.fable-crosshair::after{height:1px;left:-24px;right:-24px;top:50%}
  .fable-art-label { position:absolute; color:rgba(233,228,216,.56); font:600 .55rem/1 ui-monospace,SFMono-Regular,monospace; letter-spacing:.16em; writing-mode:vertical-rl; text-transform:uppercase; }.fable-art-label.top{right:1.3rem;top:1rem}.fable-art-label.bottom{left:1.3rem;bottom:1.5rem;transform:rotate(180deg)}
  .fable-copy,.fable-brief { z-index:2; }.fable-copy h1 { position:relative; }.fable-copy h1::after { content:""; position:absolute; width:7rem; height:.35rem; background:var(--red); left:.1rem; bottom:-1.2rem; }.fable-intro{margin-top:2.8rem}.fable-readout{display:flex;gap:1rem;align-items:center;margin:0 0 1.35rem;color:rgba(233,228,216,.66);font:600 .57rem/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em}.fable-readout b{color:#f1b678}.fable-readout i{font-style:normal;color:#ee7b65}
  .fable-brief { border-color:rgba(240,231,215,.45); box-shadow:22px 24px 0 rgba(4,7,8,.25),-6px 0 0 var(--red); }.fable-map { background:linear-gradient(145deg,#213943,#102228); }.fable-map em{position:absolute;right:1.1rem;bottom:.7rem;color:rgba(238,78,63,.75);font:900 4rem/.8 Impact,Haettenschweiler,sans-serif;font-style:normal}.fable-brief-body{background:rgba(7,12,15,.33)}
  @media(max-width:1100px){.fable-hero-art{inset:5% 7% 4% 22%;opacity:.55}.fable-operator{right:-5%;bottom:-5%;width:68vw}.fable-brief{align-self:end}.fable-copy{align-self:center}.fable-art-label{display:none}}
  @media(max-width:800px){.fable-hero-art{inset:5% -10% 35% 25%;opacity:.34}.fable-operator{width:105vw;right:-25%;bottom:-16%}.fable-orbit{display:none}.fable-readout{margin-top:2.2rem}.fable-brief{z-index:3}.fable-copy h1::after{bottom:-.8rem}}
`;
document.head.appendChild(style);
