import shaderCode from "./shader.wgsl";

async function initWebGPU() {
    if (!navigator.gpu) {
        document.body.innerHTML = '<p style="color:white;font-family:monospace;padding:40px;font-size:18px">WebGPU is not supported in this browser.<br>Please use Chrome or Edge on desktop.</p>';
        return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    const canvas = document.getElementById('gpuCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'premultiplied' });

    const SIDEBAR_W = 308, TOP_H = 60, BOT_H = 68, PAD = 32;
    const availW = window.innerWidth - SIDEBAR_W - PAD;
    const availH = window.innerHeight - TOP_H - BOT_H - PAD;
    const size = Math.max(280, Math.min(availW, availH));
    canvas.width = canvas.height = size;

    const graphCanvas = document.getElementById('graphCanvas') as HTMLCanvasElement;
    const graphCtx = graphCanvas.getContext('2d')!;

    const ATOM_COUNT = 42 * 42, NEUTRON_POOL = 40000;
    let ui = { coolant: 1.0, rods: 0.5, fuel: 2.0, heat: 0.0, power: 0.0, radiation: 0.01 };
    let targets = { coolant: 1.0, rods: 0.5 };
    let flags = { az5: 0.0, contained: false, auto: false };
    let history = { heat: new Array(100).fill(0), power: new Array(100).fill(0) };

    const atomBuf  = device.createBuffer({ size: ATOM_COUNT * 16,   usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const neutrBuf = device.createBuffer({ size: NEUTRON_POOL * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const uniBuf   = device.createBuffer({ size: 32,                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const countBuf = device.createBuffer({ size: 4,                 usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    interface PendingEvent { id: number; fn: () => void; fireAt: number; }
    let pendingEvents: PendingEvent[] = [];

    function scheduleEvent(fn: () => void, delay: number) {
        const fireAt = performance.now() + delay;
        const id = window.setTimeout(() => { pendingEvents = pendingEvents.filter(e => e.id !== id); fn(); }, delay);
        pendingEvents.push({ id, fn, fireAt });
    }
    function pauseTimeline() {
        const now = performance.now();
        pendingEvents.forEach(e => clearTimeout(e.id));
        pendingEvents = pendingEvents.map(e => ({ ...e, fireAt: e.fireAt - now }));
    }
    function resumeTimeline() {
        pendingEvents = pendingEvents.map(e => {
            const remaining = Math.max(0, e.fireAt);
            const fn = e.fn;
            const id = window.setTimeout(() => { pendingEvents = pendingEvents.filter(ev => ev.id !== id); fn(); }, remaining);
            return { id, fn, fireAt: performance.now() + remaining };
        });
    }

    const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
    let paused = false;
    let last = performance.now();

    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        if (paused) { pauseTimeline(); pauseBtn.textContent = '▶ Resume'; }
        else { last = performance.now(); resumeTimeline(); pauseBtn.textContent = '⏸ Pause'; }
    });

    function resetCore() {
        pendingEvents.forEach(e => clearTimeout(e.id)); pendingEvents = [];
        paused = false;
        if (pauseBtn) { pauseBtn.textContent = '⏸ Pause'; }

        const aData = new Float32Array(ATOM_COUNT * 4);
        for (let i = 0; i < ATOM_COUNT; i++) {
            let x = (i % 42) / 42 * 1.6 - 0.8, y = Math.floor(i / 42) / 42 * 1.6 - 0.8;
            aData[i*4]=x; aData[i*4+1]=y;
            aData[i*4+2] = (x*x + y*y < 0.64) ? 1.0 : -1.0;
            aData[i*4+3] = 0.0;
        }
        const nData = new Float32Array(NEUTRON_POOL * 8);
        for (let i = 0; i < 10; i++) { nData[i*8+2]=Math.random()-0.5; nData[i*8+3]=Math.random()-0.5; nData[i*8+4]=1.0; }
        device.queue.writeBuffer(atomBuf, 0, aData);
        device.queue.writeBuffer(neutrBuf, 0, nData);
        device.queue.writeBuffer(countBuf, 0, new Uint32Array([10]));
        ui.heat=0; ui.power=0; ui.radiation=0.01; flags.az5=0; flags.contained=false; flags.auto=false;
        targets.coolant=1; targets.rods=0.5; ui.coolant=1; ui.rods=0.5;
        document.body.classList.remove('critical-alarm');
        document.getElementById('status-display')!.innerText = 'STABLE';
        history.heat.fill(0); history.power.fill(0);
        updateUI();
    }

    function updateUI() {
        (document.getElementById('coolant-slider') as HTMLInputElement).value = (ui.coolant*100).toString();
        document.getElementById('coolant-val')!.innerText = (ui.coolant*100).toFixed(0);
        (document.getElementById('rods-slider') as HTMLInputElement).value = (ui.rods*100).toString();
        document.getElementById('rods-val')!.innerText = (ui.rods*100).toFixed(0);
    }

    const sm = device.createShaderModule({ code: shaderCode });
    const cLayout = device.createBindGroupLayout({ entries: [
        {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
        {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
        {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
        {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
    ]});
    const rLayout = device.createBindGroupLayout({ entries: [
        {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
        {binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
        {binding:2,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
    ]});
    const pAtoms  = device.createComputePipeline({ layout: device.createPipelineLayout({bindGroupLayouts:[cLayout]}), compute:{module:sm,entryPoint:'computeAtoms'}});
    const pNeutr  = device.createComputePipeline({ layout: device.createPipelineLayout({bindGroupLayouts:[cLayout]}), compute:{module:sm,entryPoint:'computeNeutrons'}});
    const pRender = device.createRenderPipeline({ layout: device.createPipelineLayout({bindGroupLayouts:[device.createBindGroupLayout({entries:[]}),rLayout]}), vertex:{module:sm,entryPoint:'vertexMain'}, fragment:{module:sm,entryPoint:'fragmentMain',targets:[{format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]}, primitive:{topology:'triangle-list'}});
    const cGroup  = device.createBindGroup({ layout:cLayout, entries:[{binding:0,resource:{buffer:atomBuf}},{binding:1,resource:{buffer:neutrBuf}},{binding:2,resource:{buffer:uniBuf}},{binding:3,resource:{buffer:countBuf}}]});
    const rGroup  = device.createBindGroup({ layout:rLayout, entries:[{binding:0,resource:{buffer:atomBuf}},{binding:1,resource:{buffer:neutrBuf}},{binding:2,resource:{buffer:uniBuf}}]});

    const setT = (c:number,r:number) => { targets.coolant=c/100; targets.rods=r/100; flags.auto=true; };
    const setActive = (id:string) => { document.querySelectorAll('.scenario-card').forEach(c=>c.classList.remove('active')); document.getElementById(id)?.classList.add('active'); };
    const setStatus = (text:string) => { document.getElementById('status-display')!.innerText = text; };

    document.getElementById('run-timeline-btn')?.addEventListener('click', () => {
        resetCore(); setActive('scen-normal'); setStatus('STABLE');
        scheduleEvent(() => { setActive('scen-prep'); setStatus('XENON TRAP'); setT(35,8); }, 8000);
        scheduleEvent(() => { setStatus('CRITICAL'); setT(30,3); }, 16000);
        scheduleEvent(() => { document.getElementById('az5-btn')?.click(); }, 23000);
        scheduleEvent(() => { document.getElementById('scen-containment')?.click(); }, 32000);
    });
    document.getElementById('scen-normal')?.addEventListener('click', () => { resetCore(); setActive('scen-normal'); });
    document.getElementById('scen-prep')?.addEventListener('click',   () => { setActive('scen-prep'); setStatus('XENON TRAP'); setT(35,8); });
    document.getElementById('az5-btn')?.addEventListener('click', () => { flags.az5=1; flags.contained=false; setActive('scen-az5'); setT(ui.coolant*100,100); setStatus('MELTDOWN'); });
    document.getElementById('scen-containment')?.addEventListener('click', () => { flags.contained=true; flags.az5=0; setActive('scen-containment'); setStatus('CONTAINED'); });
    document.getElementById('restart-btn')?.addEventListener('click', resetCore);
    document.getElementById('coolant-slider')?.addEventListener('input', (e) => { ui.coolant=+(e.target as HTMLInputElement).value/100; flags.auto=false; document.getElementById('coolant-val')!.innerText=(ui.coolant*100).toFixed(0); });
    document.getElementById('rods-slider')?.addEventListener('input',   (e) => { ui.rods=+(e.target as HTMLInputElement).value/100;    flags.auto=false; document.getElementById('rods-val')!.innerText=(ui.rods*100).toFixed(0); });
    document.getElementById('fuel-select')?.addEventListener('change',  (e) => { ui.fuel=+(e.target as HTMLSelectElement).value; });

    function frame() {
        const now = performance.now(); let dt = Math.min((now-last)/1000, 0.05); last = now;
        if (!paused) {
            if (flags.auto) { ui.coolant+=Math.sign(targets.coolant-ui.coolant)*Math.min(Math.abs(targets.coolant-ui.coolant),0.3*dt); ui.rods+=Math.sign(targets.rods-ui.rods)*Math.min(Math.abs(targets.rods-ui.rods),0.3*dt); updateUI(); }
            if (flags.contained) { ui.heat=Math.max(0.3,ui.heat-dt*0.1); ui.power=Math.max(0,ui.power-dt*5); ui.radiation=Math.max(50,ui.radiation-dt*100); }
            else if (flags.az5)  { ui.heat=Math.min(1.2,ui.heat+dt*0.5); ui.power=ui.heat*2.5; ui.radiation=0.01+(ui.power*50)+Math.pow(Math.max(0,ui.heat-0.8)*10,4); }
            else                 { ui.heat=(ui.coolant<0.6&&ui.rods<0.2)?Math.min(1,ui.heat+dt*0.1):Math.max(0,ui.heat-dt*0.2); ui.power=ui.heat*(1-ui.rods); ui.radiation=0.01+ui.power*50; }

            device.queue.writeBuffer(uniBuf, 0, new Float32Array([dt,ui.coolant,ui.rods,flags.az5,now/1000,ui.heat,ui.fuel,0]));
            const enc = device.createCommandEncoder();
            const cp = enc.beginComputePass();
            cp.setBindGroup(0,cGroup); cp.setPipeline(pAtoms); cp.dispatchWorkgroups(Math.ceil(ATOM_COUNT/64));
            cp.setPipeline(pNeutr); cp.dispatchWorkgroups(Math.ceil(NEUTRON_POOL/64)); cp.end();
            const rp = enc.beginRenderPass({colorAttachments:[{view:ctx.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
            rp.setPipeline(pRender); rp.setBindGroup(1,rGroup); rp.draw(6,ATOM_COUNT+NEUTRON_POOL); rp.end();
            device.queue.submit([enc.finish()]);

            history.heat.push(ui.heat); history.heat.shift(); history.power.push(ui.power); history.power.shift();
            document.getElementById('temp-num-display')!.innerText  = Math.floor(200+ui.heat*2800)+(flags.contained?' °C (Decay)':' °C');
            document.getElementById('power-num-display')!.innerText = Math.floor(ui.power*3200)+' MWt';
            document.getElementById('rad-display')!.innerText = ui.radiation>1000?ui.radiation.toExponential(2)+' Sv/h':ui.radiation.toFixed(2)+' Sv/h';
            document.body.classList.toggle('critical-alarm', ui.heat>0.8&&!flags.contained);
        }
        drawGraph(); requestAnimationFrame(frame);
    }

    function drawGraph() {
        const w=graphCanvas.width, h=graphCanvas.height;
        graphCtx.fillStyle='#030609'; graphCtx.fillRect(0,0,w,h);
        graphCtx.strokeStyle='rgba(26,42,58,0.8)'; graphCtx.lineWidth=1; graphCtx.beginPath();
        for(let x=0;x<w;x+=24){graphCtx.moveTo(x,0);graphCtx.lineTo(x,h);}
        for(let y=0;y<h;y+=20){graphCtx.moveTo(0,y);graphCtx.lineTo(w,y);}
        graphCtx.stroke();
        const drawLine=(data:number[],col:string)=>{graphCtx.strokeStyle=col;graphCtx.lineWidth=1.5;graphCtx.beginPath();data.forEach((v,i)=>{const x=(i/100)*w,y=h-Math.min(v,1.2)*h*0.8;i===0?graphCtx.moveTo(x,y):graphCtx.lineTo(x,y);});graphCtx.stroke();};
        drawLine(history.heat,'#ff4444'); drawLine(history.power,'#00e5ff');
    }

    resetCore(); requestAnimationFrame(frame);
}

window.onload = initWebGPU;
