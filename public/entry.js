/* Keep a failed stylesheet/script or service connection from exposing the
 * unstyled workbench. This guard loads before the application scripts. */
(() => {
  let finished = false;
  const message = document.getElementById('startupMessage');
  const reload = document.getElementById('startupReload');
  const fail = text => {
    if (finished) return;
    message.textContent = text;
    reload.hidden = false;
  };
  const timer = setTimeout(() => fail('工作台仍在加载。请检查连接，或使用接入包中的“打开协作网页”启动器重新打开。'), 15000);
  window.scitagEntry = {
    fail,
    ready() {
      if (getComputedStyle(document.getElementById('gate')).position !== 'fixed') {
        fail('界面样式没有加载，请重新解压完整接入包，并使用“打开协作网页”启动器打开。');
        return;
      }
      finished = true; clearTimeout(timer);
      document.documentElement.classList.remove('scitag-loading');
      document.getElementById('startupNotice').hidden = true;
    },
  };
  window.addEventListener('error', event => {
    if (finished) return;
    if (event.target?.tagName === 'SCRIPT' || event.target?.rel === 'stylesheet' || event instanceof ErrorEvent) {
      fail('界面程序未能完整加载，请重新解压最新版接入包，并通过“打开协作网页”启动器打开。');
    }
  }, true);
  if (location.protocol === 'file:') fail('请双击接入包中的“打开协作网页.cmd”，再打开终端显示的本机网址。无需直接打开 HTML 文件。');
})();
