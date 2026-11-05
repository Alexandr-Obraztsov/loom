import { contextBridge, ipcRenderer } from "electron";

// the page gets exactly one capability: asking which project it works on
contextBridge.exposeInMainWorld("loom", {
  project: (): Promise<string> => ipcRenderer.invoke("loom:project") as Promise<string>,
});

// main sends one end of a fresh MessageChannel on every page load; hand it over to the page
ipcRenderer.on("loom:port", (event) => {
  window.postMessage("loom:port", "*", [...event.ports]);
});
