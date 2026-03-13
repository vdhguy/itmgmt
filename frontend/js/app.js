  // ── VERSION
  fetch('/api/version').then(r => r.json()).then(d => {
    const el = document.getElementById('app-version');
    if (el && d.version) el.textContent = `v${d.version}`;
  }).catch(() => {});

  // ── GLPI MODAL (close)
  document.getElementById('glpi-modal-close').onclick = () => { document.getElementById('glpi-modal').hidden = true; };
  document.getElementById('glpi-modal').addEventListener('click', e => { if (e.target === document.getElementById('glpi-modal')) document.getElementById('glpi-modal').hidden = true; });

  // ── STATE
  let devices = [], selRow = null, activeUserCard = null;
  let sortCol = 'deviceName', sortDir = 1; // 1=asc, -1=desc
  let autopatchMembers = [];      // Test ring (pour le panel appareil)
  let autopatchMembersLast = [];  // Last ring
  let autopatchLoadedAt = 0;      // timestamp du dernier chargement
  let networkTopology   = null;   // { nodes, edges }
  let networkLoadedAt   = 0;
  let netSelectedNode   = null;

  // ── UTILS
  const $ = id => document.getElementById(id);

  function bytes(b) {
    if (!b) return '—';
    const gb = b / 1073741824;
    return gb >= 1 ? `${gb.toFixed(1)} Go` : `${(b / 1048576).toFixed(0)} Mo`;
  }

  function ago(d) {
    if (!d) return '—';
    const days = Math.floor((Date.now() - new Date(d)) / 86400000);
    if (days === 0) return "Aujourd'hui";
    if (days === 1) return 'Hier';
    if (days < 7)  return `Il y a ${days} j`;
    if (days < 30) return `Il y a ${Math.floor(days/7)} sem`;
    return `Il y a ${Math.floor(days/30)} mois`;
  }

  function stale(d) {
    return !d || Date.now() - new Date(d) > 7*86400000;
  }

  function osIcon(os) {
    if (!os) return '□';
    const s = os.toLowerCase();
    if (s.includes('windows')) return '⊞';
    if (s.includes('mac'))     return '◈';
    if (s.includes('linux'))   return '◉';
    return '□';
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('fr-FR', {day:'2-digit',month:'2-digit',year:'numeric'});
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('fr-FR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  function fmtTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
  }

  function logonStats(logons) {
    if (!logons.length) return { firstToday: null, lastActivity: null };
    const today = new Date().toDateString();
    const todayEntries = logons.filter(l => new Date(l.lastLogOnDateTime).toDateString() === today);
    const firstToday = todayEntries.length
      ? todayEntries.reduce((a, b) => new Date(a.lastLogOnDateTime) < new Date(b.lastLogOnDateTime) ? a : b)
      : null;
    const lastActivity = logons.reduce((a, b) =>
      new Date(a.lastLogOnDateTime) > new Date(b.lastLogOnDateTime) ? a : b
    );
    return { firstToday, lastActivity };
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).map(p=>p[0]).join('').toUpperCase().slice(0,2);
  }

  // ── FETCH
  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j.detail ? ` — ${JSON.stringify(j.detail)}` : (j.error ? ` — ${j.error}` : ''); } catch {}
      throw new Error(`HTTP ${r.status}${detail}`);
    }
    return r.json();
  }

  // ── USER SESSION
  fetch('/auth/me').then(r => r.ok ? r.json() : null).then(u => {
    if (!u) return;
    const status = document.querySelector('.status');
    const userEl = document.createElement('div');
    userEl.className = 'session-user';
    userEl.innerHTML = `<span class="session-name">${u.name || u.upn}</span><a href="/auth/logout" class="session-logout">Déconnexion</a>`;
    status.before(userEl);
  });

  // ── STATS
  function setStats(list) {
    const win   = list.filter(d => d.operatingSystem?.toLowerCase().includes('windows')).length;
    const syncd = list.filter(d => !stale(d.lastSyncDateTime)).length;
    $('s-total').textContent = list.length;
    $('s-win').textContent   = win;
    $('s-ok').textContent    = syncd;
    $('s-old').textContent   = list.length - syncd;
  }

  // ── DEVICES TABLE
  function sortedList(list) {
    return [...list].sort((a, b) => {
      let va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
      if (sortCol === 'lastSyncDateTime') {
        va = va ? new Date(va).getTime() : 0;
        vb = vb ? new Date(vb).getTime() : 0;
        return (va - vb) * sortDir;
      }
      return va.toString().localeCompare(vb.toString(), 'fr', { sensitivity: 'base' }) * sortDir;
    });
  }

  function renderDevices(list) {
    const tb = $('dev-body');
    tb.innerHTML = '';
    sortedList(list).forEach((d, i) => {
      const tr = document.createElement('tr');
      tr.dataset.id = d.id;
      tr.style.animationDelay = `${i * 0.025}s`;
      const old = stale(d.lastSyncDateTime);
      tr.innerHTML = `
        <td class="dev-name">${d.deviceName || '—'}</td>
        <td>
          <span class="os-row">
            <span>${osIcon(d.operatingSystem)}</span>
            <span>${d.operatingSystem || '—'}</span>
            ${d.osVersion ? `<span class="os-ver">${d.osVersion}</span>` : ''}
          </span>
        </td>
        <td class="muted">${d.manufacturer || '—'} / ${d.model || '—'}</td>
        <td class="sync ${old?'old':'ok'}">${ago(d.lastSyncDateTime)}</td>
      `;
      tr.addEventListener('click', () => openPanel(d, tr));
      tb.appendChild(tr);
    });
  }

  function filterDev(q) {
    if (!q) return devices;
    const s = q.toLowerCase();
    return devices.filter(d =>
      [d.deviceName, d.operatingSystem, d.manufacturer, d.model, d.osVersion]
        .some(v => v?.toLowerCase().includes(s))
    );
  }

  async function loadDevices() {
    try {
      devices = await api('/api/devices');
      $('dev-loading').style.display = 'none';
      $('dev-table').style.display = '';
      setStats(devices);
      renderDevices(devices);
      $('badge-dev').textContent = `${devices.length} appareil${devices.length!==1?'s':''}`;
      $('ts').textContent = new Date().toLocaleTimeString('fr-FR');
    } catch(e) {
      $('dev-loading').innerHTML = `<span style="color:var(--red)">Erreur : ${e.message}</span>`;
    }
  }

  // ── PANEL
  async function openPanel(d, row) {
    if (selRow) selRow.classList.remove('sel');
    selRow = row; row.classList.add('sel');

    $('p-name').textContent = d.deviceName || '—';

    const fields = [
      ['OS',            `${d.operatingSystem||'—'} ${d.osVersion||''}`],
      ['Fabricant',     d.manufacturer || '—'],
      ['Modèle',        d.model || '—'],
      ['N° série',      d.serialNumber || '—'],
      ['Enrollé le',    fmtDate(d.enrolledDateTime)],
      ['Dernière sync', fmtDateTime(d.lastSyncDateTime)],
    ];

    $('p-fields').innerHTML = fields.map(([l,v]) => `
      <div class="field">
        <div class="fl">${l}</div>
        <div class="fv">${v}</div>
      </div>
    `).join('') + `<div class="field"><div class="fl">Adresse IP</div><div class="fv" id="p-ip"><span class="blink">…</span></div></div>`;

    api(`/api/devices/resolve?hostname=${encodeURIComponent(d.deviceName)}`)
      .then(({ ips }) => {
        const el = $('p-ip');
        if (el) el.textContent = ips && ips.length ? ips.join(', ') : '—';
      })
      .catch(() => { const el = $('p-ip'); if (el) el.textContent = '—'; });

    // Bouton TeamViewer
    const tvBtn = $('p-tv-btn');
    tvBtn.hidden = true;
    tvBtn.className = 'btn-tv';
    tvBtn.onclick = null;
    if (d.deviceName) {
      api(`/api/teamviewer/device?name=${encodeURIComponent(d.deviceName)}`)
        .then(({ found, remotecontrol_id, online_state, reason }) => {
          if (!found || reason === 'not_configured') return;
          tvBtn.hidden = false;
          const id = (remotecontrol_id || '').replace(/\D/g, '');
          const state = (online_state || '').toLowerCase();
          if (state === 'online' || state === 'busy') {
            tvBtn.className = state === 'busy' ? 'btn-tv busy' : 'btn-tv online';
            tvBtn.title = state === 'busy' ? 'Ouvrir TeamViewer — Occupé' : 'Ouvrir TeamViewer — En ligne';
            tvBtn.onclick = () => {
              const a = document.createElement('a');
              a.href = `teamviewer10://control?device=${id}`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            };
          } else {
            tvBtn.className = 'btn-tv offline';
            tvBtn.title = `TeamViewer — ${online_state || 'Hors ligne'}`;
            tvBtn.onclick = null;
          }
        })
        .catch(() => {});
    }

    // Affichage immédiat avec les données du device
    if (d.userDisplayName || d.userPrincipalName) {
      const name = d.userDisplayName || d.userPrincipalName;
      $('p-user').innerHTML = `
        <div class="user-card" id="p-user-card">
          <div class="avatar">${initials(name)}</div>
          <div style="min-width:0">
            <div class="u-name">${name}</div>
            <div class="u-upn">${d.userPrincipalName || d.emailAddress || ''}</div>
            <div class="u-upn" id="p-first-login" style="margin-top:3px;color:var(--text-muted)"><span class="blink">…</span></div>
            <div class="u-upn" id="p-last-activity" style="margin-top:1px;color:var(--text-muted)"></div>
          </div>
        </div>`;

      // Fetch sessions poste (usersLoggedOn via beta API)
      api(`/api/devices/${d.id}/logons`)
        .then(logons => {
          const elFirst = $('p-first-login');
          const elLast  = $('p-last-activity');
          const { firstToday, lastActivity } = logonStats(logons);
          if (elFirst) elFirst.textContent = firstToday
            ? `1ère connexion : ${fmtTime(firstToday.lastLogOnDateTime)}`
            : '1ère connexion : —';
          if (elLast) elLast.textContent = lastActivity
            ? `Dernière activité : ${fmtDateTime(lastActivity.lastLogOnDateTime)}`
            : 'Dernière activité : —';
        })
        .catch(() => {
          const elFirst = $('p-first-login');
          const elLast  = $('p-last-activity');
          if (elFirst) elFirst.textContent = '1ère connexion : —';
          if (elLast)  elLast.textContent  = 'Dernière activité : —';
        });
    } else {
      $('p-user').innerHTML = '<span style="color:var(--text-muted);font-size:12px">Aucun utilisateur associé</span>';
    }

    // Matériel
    $('p-hardware').innerHTML = '<span class="blink">Chargement…</span>';
    api(`/api/inventory/${d.id}`)
      .then(hw => {
        const total = hw.totalStorageSpaceInBytes || 0;
        const used  = total - (hw.freeStorageSpaceInBytes || 0);
        const pct   = total ? Math.round(used / total * 100) : 0;
        const cls   = pct < 60 ? 'low' : pct < 85 ? 'mid' : 'high';
        const ram   = hw.physicalMemoryInBytes;
        let html = '';
        if (total) html += `
          <div class="metric">
            <div class="metric-head">
              <span class="mlabel">Stockage</span>
              <span class="mval">${bytes(used)} / ${bytes(total)} &middot; ${pct}%</span>
            </div>
            <div class="bar"><div class="fill ${cls}" style="width:${pct}%"></div></div>
          </div>`;
        if (ram) html += `
          <div class="metric">
            <div class="metric-head">
              <span class="mlabel">RAM</span>
              <span class="ram-tag">${bytes(ram)}</span>
            </div>
          </div>`;
        if (!total && !ram) html = '<span style="color:var(--text-muted);font-size:12px">Données matérielles non disponibles</span>';
        $('p-hardware').innerHTML = html;
      })
      .catch(() => { $('p-hardware').innerHTML = '<span style="color:var(--text-muted);font-size:12px">—</span>'; });

    // Sécurité — Defender
    $('p-av-badge').className = 'sec-badge loading';
    $('p-av-badge').textContent = 'Chargement Defender…';
    api(`/api/devices/${d.id}/protection`)
      .then(p => {
        const el = $('p-av-badge');
        const avOk   = p.antivirusEnabled !== false && p.malwareProtectionEnabled !== false && p.realTimeProtectionEnabled !== false;
        const issues = [];
        if (p.antivirusEnabled === false)          issues.push('Antivirus désactivé');
        if (p.realTimeProtectionEnabled === false) issues.push('Protection temps réel off');
        if (p.signatureUpdateOverdue === true)     issues.push('Signatures obsolètes');
        if (p.quickScanOverdue === true || p.fullScanOverdue === true) issues.push('Scan en retard');
        if (!avOk || issues.some(i => i.includes('désactivé') || i.includes('off'))) {
          el.className = 'sec-badge danger';
          el.innerHTML = `<span class="sec-dot"></span> ${issues[0] || 'Protection inactive'}`;
        } else if (issues.length) {
          el.className = 'sec-badge warn';
          el.innerHTML = `<span class="sec-dot"></span> ${issues.join(' · ')}`;
        } else {
          el.className = 'sec-badge ok';
          el.innerHTML = '<span class="sec-dot"></span> Defender OK';
        }
      })
      .catch(() => {
        $('p-av-badge').className = 'sec-badge unavail';
        $('p-av-badge').textContent = 'Defender : données non disponibles';
      });

    // Sécurité — Vulnérabilités critiques Microsoft
    const vulnEl = $('p-vuln-badge');
    vulnEl.className = 'sec-badge loading';
    vulnEl.innerHTML = `
      <span>Analyse des vulnérabilités…</span>
      <div class="vuln-progress-wrap"><div class="vuln-progress-bar indeterminate"></div></div>`;
    $('p-vuln-detail').style.display = 'none';
    $('p-vuln-detail').innerHTML = '';
    $('p-exploit-badge').style.display = 'none';
    $('p-exploit-badge').innerHTML = '';
    if (d.deviceName) {
      api(`/api/security/${encodeURIComponent(d.deviceName)}/criticalVulns`)
        .then(({ count, vulns, exploitCount, exploitBySoftware }) => {
          const el = $('p-vuln-badge');

          // Badge exploit + liste logiciels
          if (exploitCount > 0) {
            const eb = $('p-exploit-badge');
            eb.style.display = '';
            eb.className = 'sec-badge exploit';
            const swList = (exploitBySoftware || []).map(s =>
              `<span class="exploit-sw">${s.name}<span class="exploit-sw-count">${s.count}</span></span>`
            ).join('');
            eb.innerHTML = `<span class="sec-dot"></span> ${exploitCount} exploit${exploitCount > 1 ? 's' : ''} publics connus`
              + (swList ? `<div class="exploit-sw-list">${swList}</div>` : '');
          }

          if (count === null) {
            el.className = 'sec-badge unavail';
            el.textContent = 'Vulnérabilités : appareil non onboardé MDE';
            return;
          }
          if (count === 0) {
            el.className = 'sec-badge ok';
            el.innerHTML = '<span class="sec-dot"></span> Aucune vulnérabilité critique Microsoft';
            return;
          }

          const label = `<span class="vuln-sev critical">${count} Critique${count > 1 ? 's' : ''}</span>`;
          const devId = (d.azureADDeviceId || '').toLowerCase();
          const inTest = autopatchMembers.some(m => (m.deviceId || '').toLowerCase() === devId);
          const inLast = autopatchMembersLast.some(m => (m.deviceId || '').toLowerCase() === devId);

          if (inLast) {
            el.className = 'sec-badge added';
            el.innerHTML = `<span class="sec-dot"></span> ${label} — Ring Last`;
          } else if (inTest) {
            el.className = 'sec-badge added';
            el.innerHTML = `<span class="sec-dot"></span> ${label} — Ring Test`;
            // Bouton transfert Test → Last
            el.style.flexDirection = 'column'; el.style.alignItems = 'flex-start'; el.style.gap = '6px';
            const transferBtn = document.createElement('button');
            transferBtn.className = 'ap-btn-sm btn-transfer';
            transferBtn.textContent = 'Transférer → Ring Last';
            transferBtn.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer;border:1px solid currentColor;background:transparent;color:inherit;';
            transferBtn.onclick = async () => {
              transferBtn.disabled = true; transferBtn.textContent = '…';
              try {
                await api('/api/autopatch/transfer', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ azureADDeviceId: d.azureADDeviceId, from: 'test', to: 'last' }),
                });
                // Mise à jour optimiste
                const devId = (d.azureADDeviceId || '').toLowerCase();
                const moved = autopatchMembers.find(m => (m.deviceId || '').toLowerCase() === devId);
                autopatchMembers = autopatchMembers.filter(m => (m.deviceId || '').toLowerCase() !== devId);
                if (moved && !autopatchMembersLast.some(m => (m.deviceId || '').toLowerCase() === devId)) {
                  autopatchMembersLast.push(moved);
                }
                renderAutopatch();
                el.innerHTML = `<span class="sec-dot"></span> ${label} — Ring Last`;
                el.style.flexDirection = ''; el.style.alignItems = ''; el.style.gap = '';
              } catch(e) {
                el.className = 'sec-badge warn';
                el.textContent = `Erreur : ${e.message}`;
              }
            };
            el.appendChild(transferBtn);
          } else {
            el.className = 'sec-badge danger clickable';
            el.title = 'Cliquer pour ajouter au Ring Test';
            el.innerHTML = `<span class="sec-dot"></span> ${label} — <u>Ajouter au Ring Test</u>`;
            el.onclick = async () => {
              if (!d.azureADDeviceId) return;
              el.className = 'sec-badge loading';
              el.innerHTML = `<div class="spinner" style="width:12px;height:12px;border-width:2px"></div> Ajout en cours…`;
              el.onclick = null;
              try {
                await addToAutopatchById(d.azureADDeviceId, 'test');
                el.className = 'sec-badge added';
                el.innerHTML = `<span class="sec-dot"></span> ${label} — Ring Test`;
              } catch(e) {
                el.className = 'sec-badge warn';
                el.textContent = `Erreur : ${e.message}`;
              }
            };
          }

          // Liste des CVE critiques Microsoft
          if (vulns && vulns.length) {
            const detail = $('p-vuln-detail');
            detail.style.display = '';
            detail.innerHTML = `
              <table class="vuln-table">
                <thead><tr><th>CVE</th><th>CVSS</th></tr></thead>
                <tbody>
                  ${vulns.map(v => `
                    <tr>
                      <td class="vuln-id">${v.id}</td>
                      <td>${v.cvssV3 != null ? v.cvssV3.toFixed(1) : '—'}</td>
                    </tr>`).join('')}
                </tbody>
              </table>`;
          }
        })
        .catch(e => {
          $('p-vuln-badge').className = 'sec-badge warn';
          $('p-vuln-badge').textContent = `Vulnérabilités : erreur (${e.message})`;
        });
    } else {
      vulnEl.className = 'sec-badge unavail';
      vulnEl.textContent = 'Vulnérabilités : non disponibles';
    }

    // ── LAPS
    const lapsEl = $('p-laps');
    lapsEl.innerHTML = '<button class="btn-reveal" id="p-laps-btn">Révéler le mot de passe</button>';
    $('p-laps-btn').addEventListener('click', async function() {
      if (!d.azureADDeviceId) { lapsEl.textContent = 'ID Azure AD manquant'; return; }
      this.disabled = true; this.textContent = '…';
      try {
        const data = await api(`/api/security/laps/${d.azureADDeviceId}`);
        if (!data || !data.credentials?.length) {
          lapsEl.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Aucune donnée LAPS disponible</span>';
          return;
        }
        const cred = data.credentials[0];
        const lapsPwd = cred.passwordBase64 ? atob(cred.passwordBase64) : null;
        lapsEl.innerHTML = `<div class="cred-block"></div>`;
        const block = lapsEl.querySelector('.cred-block');
        [
          ['Compte', cred.accountName || 'Administrator', false],
          ['Mot de passe', lapsPwd, true],
          ['Sauvegardé le', fmtDateTime(cred.backupDateTime), false],
        ].forEach(([label, val, copyable]) => {
          const row = document.createElement('div');
          row.className = 'cred-row';
          row.innerHTML = `<span class="cred-label">${label}</span><span class="cred-val">${val || '—'}</span>`;
          if (copyable && val) {
            const btn = document.createElement('button');
            btn.className = 'btn-copy'; btn.textContent = 'Copier';
            btn.addEventListener('click', () => {
              navigator.clipboard.writeText(val);
              btn.textContent = 'Copié'; btn.classList.add('copied');
              setTimeout(() => { btn.textContent = 'Copier'; btn.classList.remove('copied'); }, 2000);
            });
            row.appendChild(btn);
          }
          block.appendChild(row);
        });
      } catch(e) {
        lapsEl.innerHTML = `<span style="color:var(--red);font-size:12px">Erreur : ${e.message}</span>`;
      }
    });

    // ── BitLocker
    const blEl = $('p-bitlocker');
    blEl.innerHTML = '<button class="btn-reveal" id="p-bl-btn">Révéler les clés BitLocker</button>';
    $('p-bl-btn').addEventListener('click', async function() {
      if (!d.azureADDeviceId) { blEl.textContent = 'ID Azure AD manquant'; return; }
      this.disabled = true; this.textContent = '…';
      try {
        const keys = await api(`/api/security/bitlocker/${d.azureADDeviceId}`);
        if (!keys.length) {
          blEl.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Aucune clé BitLocker trouvée</span>';
          return;
        }
        const block = document.createElement('div');
        block.className = 'cred-block';
        keys.forEach(k => {
          const row = document.createElement('div');
          row.className = 'cred-row';
          row.innerHTML = `
            <span class="cred-label">${k.volumeType || 'Volume'}<br><span style="font-weight:400;text-transform:none;letter-spacing:0">${fmtDate(k.createdDateTime)}</span></span>
            <span class="cred-val">${k.key || '—'}</span>
          `;
          if (k.key) {
            const btn = document.createElement('button');
            btn.className = 'btn-copy'; btn.textContent = 'Copier';
            btn.addEventListener('click', () => {
              navigator.clipboard.writeText(k.key);
              btn.textContent = 'Copié'; btn.classList.add('copied');
              setTimeout(() => { btn.textContent = 'Copier'; btn.classList.remove('copied'); }, 2000);
            });
            row.appendChild(btn);
          }
          block.appendChild(row);
        });
        blEl.innerHTML = '';
        blEl.appendChild(block);
      } catch(e) {
        blEl.innerHTML = `<span style="color:var(--red);font-size:12px">Erreur : ${e.message}</span>`;
      }
    });

    $('panel').classList.add('open');
    $('main').classList.add('shifted');
  }

  function closePanel() {
    $('panel').classList.remove('open');
    $('main').classList.remove('shifted');
    if (selRow) { selRow.classList.remove('sel'); selRow = null; }
  }

  // ── NAVIGATE TO DEVICE
  function navigateToDevice(id) {
    document.querySelector('.tab[data-tab="devices"]').click();
    const device = devices.find(d => d.id === id);
    if (!device) return;
    const tr = document.querySelector(`#dev-body tr[data-id="${id}"]`);
    if (tr) openPanel(device, tr);
  }

  // ── AUTOPATCH
  async function loadAutopatch(force = false) {
    const COOLDOWN = 5 * 60 * 1000; // 5 minutes
    if (!force && autopatchLoadedAt && Date.now() - autopatchLoadedAt < COOLDOWN) return;
    // Garder les données existantes visibles pendant le rechargement
    const hasData = autopatchMembers.length || autopatchMembersLast.length;
    if (!hasData) {
      $('ap-loading').style.display = 'flex';
      $('ap-members-wrap').style.display = 'none';
    }
    const refreshBtn = $('ap-refresh');
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '…'; }
    try {
      [autopatchMembers, autopatchMembersLast] = await Promise.all([
        api('/api/autopatch/members?ring=test'),
        api('/api/autopatch/members?ring=last'),
      ]);
      autopatchLoadedAt = Date.now();
      const t = new Date(autopatchLoadedAt);
      if ($('ap-last-update')) $('ap-last-update').textContent = `Mis à jour à ${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}`;
    } catch(e) {
      if (!hasData) $('ap-loading').innerHTML = `<span style="color:var(--red)">Erreur : ${e.message}</span>`;
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ Actualiser'; }
      return;
    }
    $('ap-loading').style.display = 'none';
    $('ap-members-wrap').style.display = '';
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ Actualiser'; }
    renderAutopatch();
    populateAutopatchSelect();
  }

  function renderRingList(containerId, emptyId, countId, members, ring) {
    const list = $(containerId);
    list.innerHTML = '';
    members = [...members].sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '', 'fr', { sensitivity: 'base' })
    );
    $(emptyId).style.display = members.length ? 'none' : '';
    $(countId).textContent = members.length ? `(${members.length})` : '';
    const otherRing = ring === 'test' ? 'last' : 'test';
    const otherLabel = ring === 'test' ? 'Transférer → Last' : 'Transférer → Test';
    members.forEach(m => {
      const div = document.createElement('div');
      div.className = 'ap-member';
      div.innerHTML = `
        <div class="ap-member-name">${m.displayName || '—'}</div>
        <div class="ap-member-actions">
          <button class="btn-transfer ap-btn-sm">${otherLabel}</button>
          <button class="btn-remove ap-btn-sm">Retirer</button>
        </div>
      `;
      div.querySelector('.btn-remove').addEventListener('click', async function() {
        this.disabled = true; this.textContent = '…';
        try {
          await api(`/api/autopatch/members/${m.id}?ring=${ring}`, { method: 'DELETE' });
          if (ring === 'test') autopatchMembers = autopatchMembers.filter(x => x.id !== m.id);
          else autopatchMembersLast = autopatchMembersLast.filter(x => x.id !== m.id);
          renderAutopatch();
          populateAutopatchSelect();
        } catch(e) {
          alert(`Erreur : ${e.message}`);
          this.disabled = false; this.textContent = 'Retirer';
        }
      });
      div.querySelector('.btn-transfer').addEventListener('click', async function() {
        this.disabled = true; this.textContent = '…';
        try {
          await api('/api/autopatch/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ azureADDeviceId: m.deviceId, from: ring, to: otherRing }),
          });
          // Mise à jour optimiste : déplace localement sans attendre la propagation Azure AD
          if (ring === 'test') {
            autopatchMembers = autopatchMembers.filter(x => x.id !== m.id);
            if (!autopatchMembersLast.some(x => x.id === m.id)) autopatchMembersLast.push(m);
          } else {
            autopatchMembersLast = autopatchMembersLast.filter(x => x.id !== m.id);
            if (!autopatchMembers.some(x => x.id === m.id)) autopatchMembers.push(m);
          }
          renderAutopatch();
          populateAutopatchSelect();
        } catch(e) {
          alert(`Erreur : ${e.message}`);
          this.disabled = false; this.textContent = otherLabel;
        }
      });
      list.appendChild(div);
    });
  }

  function renderAutopatch() {
    renderRingList('ap-test-list', 'ap-test-empty', 'ap-test-count', autopatchMembers, 'test');
    renderRingList('ap-last-list', 'ap-last-empty', 'ap-last-count', autopatchMembersLast, 'last');
  }

  // Combobox autopatch — liste des appareils filtrables
  let apComboDevices = []; // appareils éligibles (hors membres actuels)

  function populateAutopatchSelect() {
    const allMemberIds = new Set([
      ...autopatchMembers.map(m => (m.deviceId || '').toLowerCase()),
      ...autopatchMembersLast.map(m => (m.deviceId || '').toLowerCase()),
    ]);
    apComboDevices = [...devices]
      .filter(d => d.azureADDeviceId && !allMemberIds.has(d.azureADDeviceId.toLowerCase()))
      .sort((a, b) => (a.deviceName || '').localeCompare(b.deviceName || '', 'fr'));
    // Réinitialise la sélection
    $('ap-add-sel').value = '';
    $('ap-add-input').value = '';
  }

  function apComboFilter(q) {
    const drop = $('ap-add-dropdown');
    const lower = q.toLowerCase();
    const matches = apComboDevices.filter(d =>
      !lower || (d.deviceName || '').toLowerCase().includes(lower)
    );
    if (!matches.length || !q) { drop.style.display = 'none'; return; }
    drop.innerHTML = matches.slice(0, 30).map(d =>
      `<div class="ap-combo-opt" data-id="${d.azureADDeviceId}">${d.deviceName}</div>`
    ).join('');
    drop.style.display = '';
    drop.querySelectorAll('.ap-combo-opt').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        $('ap-add-sel').value = el.dataset.id;
        $('ap-add-input').value = el.textContent;
        drop.style.display = 'none';
      });
    });
  }

  $('ap-add-input').addEventListener('input', () => apComboFilter($('ap-add-input').value));
  $('ap-add-input').addEventListener('focus', () => apComboFilter($('ap-add-input').value));
  $('ap-add-input').addEventListener('blur',  () => setTimeout(() => { $('ap-add-dropdown').style.display = 'none'; }, 150));

  async function addToAutopatchById(azureADDeviceId, ring = 'test') {
    await api('/api/autopatch/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ azureADDeviceId, ring })
    });
    // Update optimiste : ajoute localement sans attendre la propagation Azure AD
    const device = devices.find(d => (d.azureADDeviceId || '').toLowerCase() === azureADDeviceId.toLowerCase());
    if (device) {
      const entry = { id: device.id, displayName: device.deviceName, deviceId: device.azureADDeviceId };
      const devIdLow = azureADDeviceId.toLowerCase();
      if (ring === 'test' && !autopatchMembers.some(m => (m.deviceId || '').toLowerCase() === devIdLow)) {
        autopatchMembers.push(entry);
      } else if (ring === 'last' && !autopatchMembersLast.some(m => (m.deviceId || '').toLowerCase() === devIdLow)) {
        autopatchMembersLast.push(entry);
      }
    }
    autopatchLoadedAt = 0; // force refresh au prochain chargement du tab
    renderAutopatch();
    populateAutopatchSelect();
  }

  $('ap-add-btn').addEventListener('click', async () => {
    const azureADDeviceId = $('ap-add-sel').value;
    if (!azureADDeviceId) return;
    const ring = $('ap-ring-sel').value;
    const btn = $('ap-add-btn');
    btn.disabled = true; btn.textContent = '…';
    try {
      await addToAutopatchById(azureADDeviceId, ring);
    } catch(e) {
      alert(`Erreur lors de l'ajout : ${e.message}`);
    }
    btn.disabled = false; btn.textContent = 'Ajouter';
  });

  // ── USER SEARCH
  async function searchUsers() {
    const q = $('q-user').value.trim();
    if (q.length < 2) return;
    const btn = $('btn-user-search');
    btn.disabled = true; btn.textContent = '…';
    $('user-results').innerHTML = '<div class="loading" style="padding:24px 0"><div class="spinner"></div><span>Recherche…</span></div>';
    $('user-devices-section').style.display = 'none';
    activeUserCard = null;
    try {
      const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      if (!users.length) {
        $('user-results').innerHTML = '<div class="empty" style="padding:24px 0;text-align:left">Aucun utilisateur trouvé.</div>';
      } else {
        $('user-results').innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'user-results';
        users.forEach(u => {
          const name = u.displayName || u.userPrincipalName || '—';
          const card = document.createElement('div');
          card.className = 'user-result-card';
          card.innerHTML = `
            <div class="avatar">${initials(name)}</div>
            <div style="min-width:0">
              <div class="u-name">${name}</div>
              <div class="u-upn">${u.userPrincipalName || u.mail || ''}</div>
            </div>
          `;
          card.addEventListener('click', () => loadUserDevices(u, card));
          wrap.appendChild(card);
        });
        $('user-results').appendChild(wrap);
      }
    } catch(e) {
      $('user-results').innerHTML = `<div style="color:var(--red);font-size:12px">Erreur : ${e.message}</div>`;
    }
    btn.disabled = false; btn.textContent = 'Rechercher';
  }

  async function loadUserDevices(user, card) {
    if (activeUserCard) activeUserCard.classList.remove('active');
    activeUserCard = card; card.classList.add('active');

    const name = user.displayName || user.userPrincipalName || '—';
    $('ud-username').textContent = name;
    $('ud-count').textContent = '';
    $('ud-cards').innerHTML = '<div class="loading" style="padding:20px 0"><div class="spinner"></div></div>';
    $('ud-empty').style.display = 'none';
    $('user-devices-section').style.display = '';

    // Tickets GLPI ouverts
    const glpiEl = $('ud-glpi');
    glpiEl.innerHTML = '<span class="blink">…</span>';
    const email = user.mail || user.userPrincipalName || '';
    api(`/api/users/${user.id}/glpi-tickets?email=${encodeURIComponent(email)}`)
      .then(({ count, tickets, reason }) => {
        if (count === null) {
          glpiEl.innerHTML = reason === 'not_configured'
            ? '<span class="glpi-badge na">GLPI non configuré</span>'
            : '<span class="glpi-badge na">Indisponible</span>';
        } else if (count === 0) {
          glpiEl.innerHTML = '<span class="glpi-badge ok">0 ticket ouvert</span>';
        } else {
          const GLPI_STATUS = { 1:'Nouveau', 2:'En cours (assigné)', 3:'En cours (planifié)', 4:'En attente', 5:'Résolu', 6:'Clos' };
          const rows = (tickets || []).map(t => {
            const statusLabel = GLPI_STATUS[t.status] || `Statut ${t.status}`;
            const dateStr = t.date ? new Date(t.date).toLocaleDateString('fr-BE', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—';
            return `<tr class="glpi-ticket-row">
              <td class="glpi-ticket-id">#${t.id}</td>
              <td class="glpi-ticket-title">${t.title || '—'}</td>
              <td><span class="glpi-status-badge s${t.status}">${statusLabel}</span></td>
              <td class="glpi-ticket-date">${dateStr}</td>
            </tr>`;
          }).join('');
          glpiEl.innerHTML = `<button class="glpi-badge warn glpi-toggle">
            ${count} ticket${count > 1 ? 's' : ''} ouvert${count > 1 ? 's' : ''}
          </button>`;
          glpiEl.querySelector('.glpi-toggle').addEventListener('click', () => {
            $('glpi-modal-sub').textContent = `${user.displayName || email} — ${count} ticket${count > 1 ? 's' : ''} ouvert${count > 1 ? 's' : ''}`;
            $('glpi-modal-body').innerHTML = `<table class="glpi-table">
              <thead><tr><th>#</th><th>Titre</th><th>Statut</th><th>Date</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`;
            $('glpi-modal').hidden = false;
          });
        }
      })
      .catch(() => { glpiEl.innerHTML = '<span class="glpi-badge na">—</span>'; });

    try {
      const devs = await api(`/api/users/${user.id}/devices`);
      $('ud-count').textContent = `${devs.length} appareil${devs.length!==1?'s':''}`;
      $('ud-cards').innerHTML = '';

      if (!devs.length) {
        $('ud-empty').style.display = '';
        return;
      }

      devs.forEach((d, i) => {
        const old = stale(d.lastSyncDateTime);
        const safeId = d.id.replace(/[^a-z0-9]/gi, '');
        const card = document.createElement('div');
        card.className = 'ud-card';
        card.style.animationDelay = `${i * 0.06}s`;
        card.innerHTML = `
          <div class="ud-card-head">
            <div class="ud-card-name-wrap">
              <div class="ud-card-name">
                <span>${osIcon(d.operatingSystem)}</span>
                ${d.deviceName || '—'}
              </div>
              <div class="ud-card-os">${d.operatingSystem || '—'}${d.osVersion ? ' · ' + d.osVersion : ''}</div>
            </div>
            <button class="btn-goto" data-id="${d.id}">Voir dans Appareils →</button>
          </div>
          <div class="ud-card-grid">
            <div class="ud-card-field">
              <div class="ud-card-label">Fabricant</div>
              <div class="ud-card-val">${d.manufacturer || '—'}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Modèle</div>
              <div class="ud-card-val">${d.model || '—'}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">N° de série</div>
              <div class="ud-card-val">${d.serialNumber || '—'}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Enrollé le</div>
              <div class="ud-card-val">${fmtDate(d.enrolledDateTime)}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Dernière sync</div>
              <div class="ud-card-val ${old ? 'old' : 'ok'}">${ago(d.lastSyncDateTime)}</div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">ID Azure AD</div>
              <div class="ud-card-val" style="font-size:10px;word-break:break-all">${d.azureADDeviceId || '—'}</div>
            </div>
          </div>
          <hr class="ud-card-divider">
          <div class="ud-card-activity">
            <div class="ud-card-field">
              <div class="ud-card-label">1ère connexion aujourd'hui</div>
              <div class="ud-card-val" id="ud-first-${safeId}"><span class="blink">…</span></div>
            </div>
            <div class="ud-card-field">
              <div class="ud-card-label">Dernière activité</div>
              <div class="ud-card-val" id="ud-last-${safeId}"><span class="blink">…</span></div>
            </div>
          </div>`;

        card.querySelector('.btn-goto').addEventListener('click', () => navigateToDevice(d.id));
        $('ud-cards').appendChild(card);
      });

      // Sign-in log des 7 derniers jours
      $('ud-signins').style.display = 'none';
      $('ud-signins-body').innerHTML = '<div class="loading" style="padding:12px 0"><div class="spinner"></div></div>';
      api(`/api/users/${user.id}/signins?days=7`)
        .then(signins => {
          const wrap = $('ud-signins-body');
          if (!signins.length) {
            wrap.innerHTML = '<div class="empty" style="padding:10px 0;font-size:12px">Aucune connexion sur 7 jours.</div>';
          } else {
            const rows = signins.map(s => {
              const ok = s.status?.errorCode === 0;
              const loc = [s.location?.city, s.location?.countryOrRegion].filter(Boolean).join(', ') || '—';
              const app = s.appDisplayName || s.clientAppUsed || '—';
              const dev = s.deviceDetail?.displayName || '—';
              return `<tr>
                <td class="muted" style="white-space:nowrap">${fmtDateTime(s.createdDateTime)}</td>
                <td>${app}</td>
                <td class="muted">${dev}</td>
                <td class="muted">${s.ipAddress || '—'}</td>
                <td class="muted">${loc}</td>
                <td><span class="signin-status ${ok ? 'ok' : 'fail'}">${ok ? 'Succès' : 'Échec'}</span></td>
              </tr>`;
            }).join('');
            wrap.innerHTML = `
              <div class="table-wrap" style="margin-top:0">
                <table class="signin-table">
                  <thead><tr>
                    <th>Date / Heure</th><th>Application</th><th>Appareil</th>
                    <th>IP</th><th>Localisation</th><th>Statut</th>
                  </tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>`;
          }
          $('ud-signins').style.display = '';
        })
        .catch(() => {
          $('ud-signins-body').innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">Sign-in log non disponible (permission AuditLog.Read.All requise).</div>';
          $('ud-signins').style.display = '';
        });

      // Logons en parallèle
      devs.forEach(d => {
        const safeId = d.id.replace(/[^a-z0-9]/gi, '');
        api(`/api/devices/${d.id}/logons`)
          .then(logons => {
            const { firstToday, lastActivity } = logonStats(logons);
            const elF = document.getElementById(`ud-first-${safeId}`);
            const elL = document.getElementById(`ud-last-${safeId}`);
            if (elF) elF.textContent = firstToday ? fmtTime(firstToday.lastLogOnDateTime) : '—';
            if (elL) elL.textContent = lastActivity ? fmtDateTime(lastActivity.lastLogOnDateTime) : '—';
          })
          .catch(() => {
            const elF = document.getElementById(`ud-first-${safeId}`);
            const elL = document.getElementById(`ud-last-${safeId}`);
            if (elF) elF.textContent = '—';
            if (elL) elL.textContent = '—';
          });
      });

    } catch(e) {
      $('ud-cards').innerHTML = `<div style="color:var(--red);font-size:12px;padding:12px 0">Erreur : ${e.message}</div>`;
    }
  }

  $('btn-user-search').addEventListener('click', searchUsers);
  $('q-user').addEventListener('keydown', e => { if (e.key === 'Enter') searchUsers(); });

  // ── FIREWALL
  let fwAutoRefresh = null;

  function fwBytes(b) {
    if (!b) return '—';
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024)       return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }

  function fwDuration(sec) {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return `${h}h ${m.toString().padStart(2,'0')}m`;
    if (m > 0) return `${m}m ${s.toString().padStart(2,'0')}s`;
    return `${s}s`;
  }

  function fwTimestamp(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' })
      + ' ' + d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit' });
  }

  function renderHubs(hubs) {
    const container = $('fw-hubs');
    container.innerHTML = (hubs || []).map(h => {
      const statusClass = h.up === null ? 'hub-unknown' : h.up ? 'hub-up' : 'hub-down';
      const statusLabel = h.up === null ? 'Inconnu' : h.up ? 'Actif' : 'Hors ligne';
      const trafficHtml = h.up && (h.incoming || h.outgoing) ? `
        <div class="hub-traffic">
          <span>↓ ${fwBytes(h.incoming)}</span>
          <span>↑ ${fwBytes(h.outgoing)}</span>
        </div>` : '';
      const ipHtml = h.up && h.remoteIp !== '—' ? `<div class="hub-ip">${h.remoteIp}</div>` : '';
      return `
        <div class="hub-card ${statusClass}">
          <div class="hub-card-top">
            <span class="hub-num">Hub ${h.hub}</span>
            <span class="hub-status-dot"></span>
          </div>
          <div class="hub-site">${h.site}</div>
          ${ipHtml}
          <div class="hub-footer">
            <span class="hub-status-label">${statusLabel}</span>
            ${trafficHtml}
          </div>
        </div>`;
    }).join('');
  }

  async function loadFirewall() {
    $('fw-loading').style.display = 'flex';
    $('fw-error').style.display = 'none';
    $('fw-hubs').innerHTML = '';
    $('fw-ssl-table').style.display = 'none';
    $('fw-ssl-empty').style.display = 'none';
    $('fw-ipsec-table').style.display = 'none';
    $('fw-ipsec-empty').style.display = 'none';
    try {
      const { ssl, ipsec, hubs, error } = await api('/api/firewall/vpn');
      $('fw-loading').style.display = 'none';

      if (error === 'not_configured') {
        $('fw-error').style.display = '';
        $('fw-error').innerHTML = '<div class="empty" style="padding:40px;color:var(--text-muted)">FortiGate non configuré.</div>';
        return;
      }

      // Hub cards
      renderHubs(hubs);

      // SSL VPN
      $('fw-ssl-count').textContent = ssl.length ? `(${ssl.length})` : '';
      if (ssl.length === 0) {
        $('fw-ssl-empty').style.display = '';
      } else {
        $('fw-ssl-table').style.display = '';
        $('fw-ssl-body').innerHTML = ssl.map(s => `
          <tr class="fw-row">
            <td><span class="fw-user">${s.username}</span></td>
            <td class="fw-mono">${s.remoteIp}</td>
            <td class="fw-mono">${s.tunnelIp}</td>
            <td>${fwTimestamp(s.connectedSince)}</td>
            <td>${fwDuration(s.duration)}</td>
            <td class="fw-bytes">${fwBytes(s.inBytes)}</td>
            <td class="fw-bytes">${fwBytes(s.outBytes)}</td>
          </tr>`).join('');
      }

      // IPSec hors-hubs
      $('fw-ipsec-count').textContent = ipsec.length ? `(${ipsec.length})` : '';
      if (ipsec.length === 0) {
        $('fw-ipsec-empty').style.display = '';
      } else {
        $('fw-ipsec-table').style.display = '';
        $('fw-ipsec-body').innerHTML = ipsec.map(t => `
          <tr class="fw-row">
            <td><span class="fw-tunnel">${t.name}</span></td>
            <td class="fw-mono">${t.remoteIp}</td>
            <td class="fw-bytes">${fwBytes(t.incoming)}</td>
            <td class="fw-bytes">${fwBytes(t.outgoing)}</td>
          </tr>`).join('');
      }

      $('fw-last-update').textContent = 'Mis à jour : ' + new Date().toLocaleTimeString('fr-BE');
    } catch (e) {
      $('fw-loading').style.display = 'none';
      $('fw-error').style.display = '';
      $('fw-error').innerHTML = `<div class="sec-badge warn" style="margin:0">Erreur FortiGate : ${e.message}</div>`;
    }
  }

  $('fw-refresh').addEventListener('click', loadFirewall);
  $('ap-refresh').addEventListener('click', () => loadAutopatch(true));

  // ── NETWORK ─────────────────────────────────────────────────────────────────
  let netRootId  = 'fortigate';  // currently displayed root
  let netNavPath = [];           // breadcrumb: [{id, label}, ...] ancestors

  async function loadNetwork(force = false) {
    // Avoid repeated cache fetches on fast tab switches (30s cooldown for cached loads)
    const COOLDOWN = 30 * 1000;
    if (!force && networkLoadedAt && Date.now() - networkLoadedAt < COOLDOWN) return;

    const hasData = !!networkTopology;
    if (!hasData) {
      $('net-loading').style.display = 'flex';
      $('net-canvas-wrap').style.display = 'none';
    }
    $('net-error').style.display = 'none';

    const btn = $('net-refresh');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    try {
      // force=true → POST refresh (triggers full SNMP rediscovery)
      // force=false → GET (returns cached topology instantly if available)
      const data = force
        ? await api('/api/network/topology/refresh', { method: 'POST' })
        : await api('/api/network/topology');

      networkTopology = data;
      networkLoadedAt = Date.now();
      netRootId  = 'fortigate';
      netNavPath = [];

      const ts = data.cachedAt ? new Date(data.cachedAt) : new Date();
      const tsStr = ts.toLocaleDateString('fr-BE', { day:'2-digit', month:'2-digit' })
                  + ' ' + ts.toLocaleTimeString('fr-BE', { hour:'2-digit', minute:'2-digit' });
      const label = data.fromCache ? `Cache du ${tsStr}` : `Découverte ${tsStr}`;
      if ($('net-last-update')) $('net-last-update').textContent = label;
    } catch (e) {
      $('net-loading').style.display = 'none';
      $('net-error').textContent = `Erreur : ${e.message}`;
      $('net-error').style.display = 'block';
      if (btn) { btn.disabled = false; btn.textContent = '↻ Actualiser'; }
      return;
    }

    $('net-loading').style.display = 'none';
    $('net-canvas-wrap').style.display = '';
    if (btn) { btn.disabled = false; btn.textContent = '↻ Actualiser'; }
    renderTopology();
  }

  // ── Device locator ──────────────────────────────────────────────────────────
  async function locateDevice() {
    const q   = ($('net-locate-q').value || '').trim();
    const btn = $('net-locate-btn');
    const out = $('net-locate-result');
    if (!q) return;

    btn.disabled = true; btn.textContent = '…';
    out.style.display = '';
    out.innerHTML = '<div class="net-locate-loading"><div class="spinner" style="width:16px;height:16px;border-width:2px"></div><span>Recherche en cours…</span></div>';

    try {
      const data = await api(`/api/network/locate?q=${encodeURIComponent(q)}`);
      renderLocateResult(data);
    } catch (e) {
      out.innerHTML = `<div class="net-locate-error">Erreur : ${e.message}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Localiser';
    }
  }

  function renderLocateResult(data) {
    const out = $('net-locate-result');
    const macHtml = data.mac
      ? `<span class="net-locate-mac">${data.mac.toUpperCase()}</span>`
      : '<span class="net-locate-mac muted">—</span>';
    const ipHtml = data.ip ? `<span class="net-locate-ip">${data.ip}</span>` : '';

    if (!data.found) {
      out.innerHTML = `<div class="net-locate-card net-locate-notfound">
        <div class="net-locate-info">${ipHtml}${macHtml}</div>
        <div class="net-locate-msg">${data.message || 'Appareil non trouvé sur les switchs'}</div>
      </div>`;
      return;
    }

    const rows = data.results.map(r => {
      const st = r.operStatus === 'up'
        ? '<span class="net-badge-up">up</span>'
        : '<span class="net-badge-down">down</span>';
      const alias = r.portAlias ? ` <span class="net-locate-alias">${r.portAlias}</span>` : '';
      return `<tr>
        <td class="net-locate-sw">${r.switch}</td>
        <td class="net-port-name">${r.port}${alias}</td>
        <td>${st}</td>
        <td class="net-locate-swip">${r.switchIp}</td>
      </tr>`;
    }).join('');

    out.innerHTML = `<div class="net-locate-card">
      <div class="net-locate-info">${ipHtml}${macHtml}</div>
      <table class="net-locate-table">
        <thead><tr><th>Switch</th><th>Port</th><th>État</th><th>IP switch</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  $('net-locate-btn').addEventListener('click', locateDevice);
  $('net-locate-q').addEventListener('keydown', e => { if (e.key === 'Enter') locateDevice(); });

  // Build directed tree from netRootId, ignoring APs
  function buildNetTree() {
    if (!networkTopology) return null;
    const { nodes, edges } = networkTopology;

    // Only switches + firewall
    const swNodes = nodes.filter(n => n.type !== 'ap');
    const nodeMap = Object.fromEntries(swNodes.map(n => [n.id, n]));

    // Undirected adjacency (switch/firewall only)
    const adj = {};
    for (const n of swNodes) adj[n.id] = [];
    for (const e of edges) {
      if (nodeMap[e.source] && nodeMap[e.target]) {
        adj[e.source].push(e.target);
        adj[e.target].push(e.source);
      }
    }

    // BFS from netRootId → parent/children relationships
    const children = {};
    const visited  = new Set([netRootId]);
    const queue    = [netRootId];
    while (queue.length) {
      const cur = queue.shift();
      children[cur] = [];
      for (const nb of (adj[cur] || [])) {
        if (!visited.has(nb)) {
          visited.add(nb);
          children[cur].push(nb);
          queue.push(nb);
        }
      }
    }

    // Recursive descendant count (switches only)
    function countDesc(id) {
      let c = 0;
      for (const ch of (children[id] || [])) c += 1 + countDesc(ch);
      return c;
    }

    return { nodeMap, children, countDesc };
  }

  function renderBreadcrumb() {
    const bc = $('net-breadcrumb');
    if (!bc) return;
    if (netNavPath.length === 0) { bc.style.display = 'none'; return; }
    bc.style.display = 'flex';
    const allItems = [...netNavPath, { id: netRootId, label: netNodeLabel(netRootId) }];
    bc.innerHTML = allItems.map((item, i) => {
      if (i === allItems.length - 1)
        return `<span class="net-bc-current">${item.label}</span>`;
      return `<span class="net-bc-link" data-id="${item.id}" data-idx="${i}">${item.label}</span><span class="net-bc-sep"> › </span>`;
    }).join('');
    bc.querySelectorAll('.net-bc-link').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        netRootId  = el.dataset.id;
        netNavPath = netNavPath.slice(0, idx);
        $('net-detail').style.display = 'none';
        renderTopology();
      });
    });
  }

  function netNodeLabel(id) {
    if (!networkTopology) return id;
    return networkTopology.nodes.find(n => n.id === id)?.label || id;
  }

  function svgEl(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

  function renderTopology() {
    if (!networkTopology) return;
    const tree = buildNetTree();
    if (!tree) return;
    const { nodeMap, children, countDesc } = tree;
    const svg = $('net-svg');
    if (!svg) return;

    renderBreadcrumb();

    const rootNode = nodeMap[netRootId];
    if (!rootNode) return;

    const childIds    = children[netRootId] || [];
    const NW = 150, NH = 60, HGAP = 30, VGAP = 100;
    const BADGE_H = 22; // extra height for expand badge below child nodes

    // Positions: root at (0,0), children spread at level 1
    const positions = { [netRootId]: { x: 0, y: 0 } };
    if (childIds.length > 0) {
      const totalW = childIds.length * NW + (childIds.length - 1) * HGAP;
      childIds.forEach((id, i) => {
        positions[id] = { x: i * (NW + HGAP) - totalW / 2 + NW / 2, y: NH + VGAP };
      });
    }

    // ViewBox — add bottom padding for badges
    const xs  = Object.values(positions).map(p => p.x);
    const ys  = Object.values(positions).map(p => p.y);
    const pad = 40;
    const hasBadges = childIds.some(id => countDesc(id) > 0);
    const vx = Math.min(...xs) - NW / 2 - pad;
    const vy = Math.min(...ys) - NH / 2 - pad;
    const vw = Math.max(...xs) - Math.min(...xs) + NW + pad * 2;
    const vh = Math.max(...ys) - Math.min(...ys) + NH + pad + (hasBadges ? BADGE_H + 16 : pad);

    svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    svg.setAttribute('width',  Math.max(vw, 600));
    svg.setAttribute('height', Math.max(vh, 200));
    svg.innerHTML = `<defs>
      <filter id="nshadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.12"/>
      </filter>
    </defs>`;

    // Helper: port label chip along an edge line
    function addPortLabel(x, y, text) {
      if (!text) return;
      const g = svgEl('g');
      const approxW = Math.max(text.length * 6.5, 30);
      const bg = svgEl('rect');
      bg.setAttribute('x', x - approxW / 2 - 3); bg.setAttribute('y', y - 10);
      bg.setAttribute('width', approxW + 6); bg.setAttribute('height', 14); bg.setAttribute('rx', 3);
      bg.setAttribute('class', 'net-port-label-bg');
      g.appendChild(bg);
      const t = svgEl('text');
      t.setAttribute('x', x); t.setAttribute('y', y);
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'middle');
      t.setAttribute('class', 'net-port-label');
      t.textContent = text;
      g.appendChild(t);
      svg.appendChild(g);
    }

    // Edges root → children (with port labels)
    for (const childId of childIds) {
      const s  = positions[netRootId];
      const t  = positions[childId];
      const x1 = s.x, y1 = s.y + NH / 2;
      const x2 = t.x, y2 = t.y - NH / 2;

      const line = svgEl('line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('class', 'net-edge');
      svg.appendChild(line);

      // Find matching edge for port labels
      const edgeData = networkTopology.edges.find(e =>
        (e.source === netRootId && e.target === childId) ||
        (e.source === childId   && e.target === netRootId)
      );
      if (edgeData) {
        // localPortName is always on the 'source' side of the stored edge
        const rootPort  = edgeData.source === netRootId ? edgeData.localPortName  : edgeData.remotePortName;
        const childPort = edgeData.source === childId   ? edgeData.localPortName  : edgeData.remotePortName;
        // Place labels at 20% and 80% along the line
        const t20x = x1 + (x2 - x1) * 0.20, t20y = y1 + (y2 - y1) * 0.20;
        const t80x = x1 + (x2 - x1) * 0.80, t80y = y1 + (y2 - y1) * 0.80;
        addPortLabel(t20x, t20y, rootPort);
        addPortLabel(t80x, t80y, childPort);
      }
    }

    // Nodes
    for (const id of [netRootId, ...childIds]) {
      const n   = nodeMap[id];
      const pos = positions[id];
      if (!n || !pos) continue;

      const isRoot     = id === netRootId;
      const descCount  = isRoot ? 0 : countDesc(id);
      const hasDesc    = descCount > 0;

      const g = svgEl('g');
      const cls = ['net-node', `net-node-${n.type}`];
      if (!n.reachable) cls.push('unreachable');
      if (isRoot) cls.push('net-node-root');
      g.setAttribute('class', cls.join(' '));
      g.setAttribute('transform', `translate(${pos.x - NW / 2},${pos.y - NH / 2})`);
      g.style.cursor = isRoot ? 'default' : 'pointer';

      // Rect
      const rect = svgEl('rect');
      rect.setAttribute('width', NW); rect.setAttribute('height', NH); rect.setAttribute('rx', 8);
      rect.setAttribute('filter', 'url(#nshadow)');
      g.appendChild(rect);

      // Icon (ASCII-safe symbols)
      const ICONS = { firewall: '■', switch: '⊟' };
      const iconEl = svgEl('text');
      iconEl.setAttribute('x', 12); iconEl.setAttribute('y', 22);
      iconEl.setAttribute('class', 'net-icon');
      iconEl.textContent = ICONS[n.type] || '⊟';
      g.appendChild(iconEl);

      // Label
      const label = svgEl('text');
      label.setAttribute('x', NW / 2); label.setAttribute('y', 26);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'net-label');
      label.textContent = n.label.length > 16 ? n.label.slice(0, 14) + '…' : n.label;
      g.appendChild(label);

      // IP
      if (n.ip) {
        const ipEl = svgEl('text');
        ipEl.setAttribute('x', NW / 2); ipEl.setAttribute('y', 42);
        ipEl.setAttribute('text-anchor', 'middle');
        ipEl.setAttribute('class', 'net-ip');
        ipEl.textContent = n.ip;
        g.appendChild(ipEl);
      }

      // Status dot (top-right)
      const dot = svgEl('circle');
      dot.setAttribute('cx', NW - 10); dot.setAttribute('cy', 10); dot.setAttribute('r', 5);
      dot.setAttribute('class', n.reachable === true  ? 'net-status-dot-up'
                               : n.reachable === false ? 'net-status-dot-down'
                               : 'net-status-dot-null');
      g.appendChild(dot);

      // "Has descendants" expand badge (below node, only on children with sub-switches)
      if (!isRoot && hasDesc) {
        const badgeW = 40;
        const bg = svgEl('rect');
        bg.setAttribute('x', NW / 2 - badgeW / 2);
        bg.setAttribute('y', NH + 6);
        bg.setAttribute('width', badgeW); bg.setAttribute('height', 18); bg.setAttribute('rx', 9);
        bg.setAttribute('class', 'net-expand-badge');
        g.appendChild(bg);

        const bt = svgEl('text');
        bt.setAttribute('x', NW / 2); bt.setAttribute('y', NH + 18);
        bt.setAttribute('text-anchor', 'middle');
        bt.setAttribute('class', 'net-expand-text');
        bt.textContent = `▾ ${descCount}`;
        g.appendChild(bt);
      }

      if (!isRoot) g.addEventListener('click', () => onNetNodeClick(n));
      svg.appendChild(g);
    }
  }

  async function onNetNodeClick(node) {
    // Push current root to breadcrumb and drill down
    netNavPath.push({ id: netRootId, label: netNodeLabel(netRootId) });
    netRootId = node.id;
    renderTopology();

    // Show port details
    $('net-detail-title').textContent = node.label;
    $('net-detail-ip').textContent    = node.ip || '—';
    $('net-detail-type').textContent  = 'Switch';
    $('net-detail').style.display = '';

    if (node.ip) {
      $('net-ports-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px">Chargement…</td></tr>';
      try {
        const data = await api(`/api/network/switch/${encodeURIComponent(node.label)}/ports`);
        renderNetPorts(data.ports);
      } catch (e) {
        $('net-ports-body').innerHTML = `<tr><td colspan="6" style="color:var(--red);padding:12px">${e.message}</td></tr>`;
      }
    } else {
      $('net-ports-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">Switch non résolu — vérifiez le DNS.</td></tr>';
    }
  }

  function renderNetPorts(ports) {
    const tbody = $('net-ports-body');
    if (!ports || !ports.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">Aucun port.</td></tr>';
      return;
    }
    // Physical ports only (exclude loopback, vlan, tunnel, mgmt)
    const physical = ports.filter(p => !/^(loopback|vlan|tunnel|oob|mgmt|lo|cpu)/i.test(p.name));

    const fmtSpeed = s => !s ? '—' : s >= 1000 ? `${s / 1000} Gb` : `${s} Mb`;
    const fmtOct   = b => {
      if (!b) return '—';
      const mb = b / 1048576;
      return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
    };

    tbody.innerHTML = physical.map(p => {
      const op  = p.operStatus  === 'up';
      const adm = p.adminStatus === 'up';
      const badge = op   ? '<span class="net-badge-up">up</span>'
                  : !adm ? '<span class="net-badge-disabled">désactivé</span>'
                  :         '<span class="net-badge-down">down</span>';
      return `<tr>
        <td class="net-port-name">${p.name}</td>
        <td class="net-port-alias">${p.alias || '—'}</td>
        <td class="net-port-speed">${fmtSpeed(p.speed)}</td>
        <td>${badge}</td>
        <td class="net-port-traffic">${fmtOct(p.inOctets)}</td>
        <td class="net-port-traffic">${fmtOct(p.outOctets)}</td>
      </tr>`;
    }).join('');
  }

  $('net-refresh').addEventListener('click', () => loadNetwork(true));
  $('net-detail-close').addEventListener('click', () => { $('net-detail').style.display = 'none'; });

  // ── TABS
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      closePanel();
      const tab = btn.dataset.tab;
      $('v-devices').style.display     = tab==='devices'     ? '' : 'none';
      $('v-user-search').style.display = tab==='user-search' ? '' : 'none';
      $('v-autopatch').style.display   = tab==='autopatch'   ? '' : 'none';
      $('v-firewall').style.display    = tab==='firewall'    ? '' : 'none';
      $('v-network').style.display     = tab==='network'     ? '' : 'none';
      if (tab === 'autopatch') loadAutopatch(false);
      if (tab === 'firewall')  loadFirewall();
      if (tab === 'network')   loadNetwork(false);
    });
  });

  // ── SEARCH
  $('q-dev').addEventListener('input', e => {
    const f = filterDev(e.target.value);
    renderDevices(f);
    $('badge-dev').textContent = `${f.length} appareil${f.length!==1?'s':''}`;
    $('dev-table').style.display = f.length ? '' : 'none';
    $('dev-empty').style.display = f.length ? 'none' : '';
  });

  // ── CLOSE
  $('p-close').addEventListener('click', closePanel);

  // ── SORT
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir *= -1;
      } else {
        sortCol = col;
        sortDir = 1;
      }
      document.querySelectorAll('th[data-col]').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
      const f = filterDev($('q-dev').value);
      renderDevices(f);
    });
  });

  // ── INIT
  loadDevices();
