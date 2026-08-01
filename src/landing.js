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
      <div class="fable-copy">
        <p class="fable-kicker">Market district // live simulation</p>
        <h1>MAKE<br>THE PUSH.</h1>
        <p class="fable-intro">A code-born tactical sandbox. Pick a session; the district builds only when you deploy.</p>
        <div class="fable-actions">
          <button class="fable-deploy" data-play="operation" type="button"><span>Deploy</span><small>Garrison operation</small><i>↗</i></button>
          <button class="fable-secondary" data-play="practice" type="button">Practice range <i>→</i></button>
        </div>
      </div>

      <aside class="fable-brief" aria-label="Operation briefing">
        <div class="fable-brief-top"><span>Featured operation</span><b>01 / 03</b></div>
        <div class="fable-map"><i></i><i></i><i></i><strong>GARRISON</strong><span>MARKET SECTOR</span></div>
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
`;
document.head.appendChild(style);
