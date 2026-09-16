'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => {
    const h = (_e, state) => cb(state);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  listMaps: () => ipcRenderer.invoke('map:list'),
  selectMap: (sel) => ipcRenderer.invoke('map:select', sel),
  setFloor: (floor) => ipcRenderer.invoke('floor:set', floor),
  toggleMini: () => ipcRenderer.invoke('mini:toggle'),
  ensureMini: () => ipcRenderer.invoke('mini:ensure'),
  setMiniOpacity: (o) => ipcRenderer.invoke('mini:opacity', o),
  miniDragStart: () => ipcRenderer.invoke('mini:drag-start'),
  miniDragEnd: () => ipcRenderer.invoke('mini:drag-end'),
  miniStatus: () => ipcRenderer.invoke('mini:status'),
  miniPing: () => ipcRenderer.invoke('mini:ping'),
  resizeMini: (scale) => ipcRenderer.send('mini:resize', scale),
  pickScreenshot: () => ipcRenderer.invoke('util:pick-screenshot'),
  togglePin: () => ipcRenderer.invoke('window:pin'),
  syncViewport: (viewport) => ipcRenderer.invoke('view:sync', viewport),
  onViewportSync: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('viewport:sync', h);
    return () => ipcRenderer.removeListener('viewport:sync', h);
  },
  getStateForMini: () => ipcRenderer.invoke('state:sync-mini'),
});
