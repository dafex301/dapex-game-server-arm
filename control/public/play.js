fetch('/api/public').then((response) => response.json()).then(({ status, profile, minecraftAddress, clientPack, autoPack, manualPack }) => {
  document.querySelector('#player-state').textContent = status.active === 'minecraft' ? 'MINECRAFT ONLINE' : status.active === 'valheim' ? 'VALHEIM ACTIVE' : 'SERVER IDLE';
  document.querySelector('#player-light').classList.toggle('online', status.active === 'minecraft');
  document.querySelector('#server-address').textContent = minecraftAddress;
  document.querySelector('#player-release').textContent = profile.release ? `${profile.name} v${profile.release}` : 'Preparing v1';
  document.querySelector('#player-version').textContent = profile.minecraftVersion;
  if (autoPack) {
    const auto = document.querySelector('#auto-download');
    auto.href = autoPack;
    auto.textContent = `PRISM AUTO UPDATE — INSTALL ONCE`;
    auto.classList.remove('disabled');
    auto.removeAttribute('aria-disabled');
  }
  if (clientPack) {
    const download = document.querySelector('#pack-download');
    download.href = clientPack;
    download.textContent = `PRISM SNAPSHOT V${profile.release}`;
    download.classList.remove('disabled');
    download.removeAttribute('aria-disabled');
  }
  if (manualPack) {
    const manual = document.querySelector('#manual-download');
    manual.href = manualPack;
    manual.textContent = `MANUAL WINDOWS V${profile.release}`;
    manual.classList.remove('disabled');
    manual.removeAttribute('aria-disabled');
  }
}).catch(() => {
  document.querySelector('#player-state').textContent = 'STATUS UNAVAILABLE';
});
