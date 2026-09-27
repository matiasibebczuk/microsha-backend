const { initResumenTrasladosScheduler } = require("./resumenTrasladosScheduler");
const { initAutoFinalizeScheduler } = require("./autoFinalizeScheduler");

function initAllSchedulers() {
  console.log("[cron] Inicializando todos los schedulers...");
  initResumenTrasladosScheduler();
  initAutoFinalizeScheduler();
  console.log("[cron] Todos los schedulers iniciados");
}

module.exports = {
  initAllSchedulers,
};
