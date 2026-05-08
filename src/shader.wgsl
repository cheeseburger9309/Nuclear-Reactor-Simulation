struct Atom { pos: vec2<f32>, state: f32, timer: f32 } 
struct Neutron { pos: vec2<f32>, vel: vec2<f32>, state: f32, padding: vec3<f32> }
struct Uniforms { deltaTime: f32, coolantLevel: f32, controlRods: f32, az5Triggered: f32, time: f32, coreHeat: f32, fuelYield: f32, padding: f32 }

@group(0) @binding(0) var<storage, read_write> compute_atoms: array<Atom>;
@group(0) @binding(1) var<storage, read_write> compute_neutrons: array<Neutron>;
@group(0) @binding(2) var<uniform> compute_params: Uniforms;
@group(0) @binding(3) var<storage, read_write> nextNeutronIdx: atomic<u32>;

@group(1) @binding(0) var<storage, read> render_atoms: array<Atom>;
@group(1) @binding(1) var<storage, read> render_neutrons: array<Neutron>;
@group(1) @binding(2) var<uniform> render_params: Uniforms;

@compute @workgroup_size(64)
fn computeAtoms(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.x;
    if (index >= arrayLength(&compute_atoms)) { return; }
    if (compute_atoms[index].state == 0.0) {
        compute_atoms[index].timer += compute_params.deltaTime;
        if (compute_atoms[index].timer > 12.0) { 
            compute_atoms[index].state = 2.0; compute_atoms[index].timer = 15.0;   
        }
    } else if (compute_atoms[index].state == 2.0) {
        compute_atoms[index].timer -= compute_params.deltaTime;
        if (compute_atoms[index].timer <= 0.0) { compute_atoms[index].state = 0.0; }
    }
}

@compute @workgroup_size(64)
fn computeNeutrons(@builtin(global_invocation_id) id: vec3<u32>) {
    let index = id.x;
    if (index >= arrayLength(&compute_neutrons)) { return; }
    if (compute_neutrons[index].state == 0.0) { return; } 

    compute_neutrons[index].pos += compute_neutrons[index].vel * compute_params.deltaTime;
    
    let b = 0.98;
    if (abs(compute_neutrons[index].pos.x) > b) { compute_neutrons[index].pos.x = sign(compute_neutrons[index].pos.x) * b; compute_neutrons[index].vel.x *= -1.0; }
    if (abs(compute_neutrons[index].pos.y) > b) { compute_neutrons[index].pos.y = sign(compute_neutrons[index].pos.y) * b; compute_neutrons[index].vel.y *= -1.0; }

    let rng = fract(sin(dot(compute_neutrons[index].pos, vec2<f32>(12.9898, 78.233)) + compute_params.time) * 43758.5453);
    if (compute_params.az5Triggered == 0.0 && rng < (compute_params.coolantLevel * 0.015 + compute_params.controlRods * 0.04)) {
        compute_neutrons[index].state = 0.0; return;
    }

    for (var i = 0u; i < arrayLength(&compute_atoms); i++) {
        if (distance(compute_neutrons[index].pos, compute_atoms[i].pos) < 0.022) { 
            if (compute_atoms[i].state == 1.0) { 
                compute_atoms[i].state = 0.0; compute_atoms[i].timer = 0.0; compute_neutrons[index].state = 0.0; 
                var spawn = u32(compute_params.fuelYield);
                if (compute_params.az5Triggered == 1.0) { spawn += 4u; } 
                for (var s = 0u; s < spawn; s++) {
                    let sIdx = atomicAdd(&nextNeutronIdx, 1u) % arrayLength(&compute_neutrons);
                    compute_neutrons[sIdx].state = 1.0; compute_neutrons[sIdx].pos = compute_atoms[i].pos;
                    let ang = rng * 6.28 + (f32(s) * 2.0);
                    compute_neutrons[sIdx].vel = vec2<f32>(cos(ang), sin(ang)) * mix(0.4, 0.8, compute_params.coreHeat);
                }
                break;
            } else if (compute_atoms[i].state == 2.0) {
                compute_atoms[i].state = 0.0; compute_neutrons[index].state = 0.0; break;
            }
        }
    }
}

struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>, @location(1) uv: vec2<f32> }

@vertex
fn vertexMain(@builtin(vertex_index) vIdx: u32, @builtin(instance_index) iIdx: u32) -> VertexOutput {
    
    var pos = array<vec2<f32>, 6>(vec2<f32>(-1,-1), vec2<f32>(1,-1), vec2<f32>(-1,1), vec2<f32>(-1,1), vec2<f32>(1,-1), vec2<f32>(1,1));

    var out: VertexOutput; out.uv = pos[vIdx];
    
    let totalAtoms = arrayLength(&render_atoms);
    if (iIdx < totalAtoms) {
        let a = render_atoms[iIdx];
        if (a.state == 1.0) { out.color = vec4<f32>(mix(vec3<f32>(0, 0.5, 0.8), vec3<f32>(1, 0.2, 0), render_params.coreHeat), 1.0); }
        else if (a.state == 2.0) { out.color = vec4<f32>(0.6, 0.1, 0.9, 1.0); }
        else { out.color = vec4<f32>(0.1, 0.1, 0.15, 0.5); }
        out.position = vec4<f32>(a.pos + (pos[vIdx] * 0.022), 0.0, 1.0);
    } else {
        let n = render_neutrons[iIdx - totalAtoms];
        out.color = vec4<f32>(1, 1, 1, 1);
        if (render_params.az5Triggered == 1.0) { out.color = vec4<f32>(1, 0.9, 0.2, 1); }
        out.position = vec4<f32>(n.pos + (pos[vIdx] * 0.012), 0.0, 1.0);
        if (n.state == 0.0) { out.position = vec4<f32>(0,0,0,0); }
    }
    return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
    let d = length(in.uv); if (d > 1.0) { discard; } 
    let core = 1.0 - smoothstep(0.85, 1.0, d);
    return vec4<f32>(in.color.rgb * (1.0 + core * 2.0), in.color.a * core);
}