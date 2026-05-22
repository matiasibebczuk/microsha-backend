const { initResumenTrasladosScheduler } = require("./resumenTrasladosScheduler");

function initAllSchedulers() {
  console.log("[cron] Inicializando todos los schedulers...");
  initResumenTrasladosScheduler();
  console.log("[cron] Todos los schedulers iniciados");
}

module.exports = {
  initAllSchedulers,
};
