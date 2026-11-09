import { defineConfig } from 'vite';
export default defineConfig({root:import.meta.dirname,clearScreen:false,
  server:{host:'127.0.0.1',port:1420,strictPort:true,watch:{ignored:['**/src-tauri/**']}},build:{outDir:'../.local/desktop-web',emptyOutDir:true,target:'es2022'}});
