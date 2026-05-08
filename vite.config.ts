import { defineConfig } from 'vite';
import wgsl from 'vite-plugin-wgsl';

export default defineConfig({
  plugins: [wgsl({ include: '**/*.wgsl' })],
  base: '/Nuclear-Reactor-Simulation/',   // ← replace with your exact GitHub repo name
});