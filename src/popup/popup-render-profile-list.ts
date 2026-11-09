// popup-render-profile-list.ts — Renders the single global profile list with
// search, rename, recolor, duplicate, and delete. A profile spans all sites, so
// switching applies to the current tab.

import type { PopupSession } from './popup-types.js';
import { getSessionHue } from './popup-types.js';
import { getSavedSessions, setSavedSessions } from './popup-session-storage.js';
import { buildColorDot } from './popup-color-picker.js';
import { startRename, RENAME_ICON } from './popup-rename-handler.js';
import { startDeleteConfirm, cancelActiveConfirm } from './popup-delete-handler.js';
import { attachOpenInTabMenu } from './popup-open-in-tab-menu.js';
import type { Localizer } from '../lib/localization.js';
import { profileSiteKey } from '../lib/profile-site.js';

// Collapsed website groups survive the list re-renders triggered by search,
// duplication and deletion within this popup instance.
const collapsedSites = new Set<string>();

export function renderSessionList(
  container: HTMLElement,
  sessions: PopupSession[],
  currentSessionId: string,
  tabId: number,
  currentUrl: string,
  localizer: Localizer,
  query = ''
): void {
  cancelActiveConfirm();

  const header = container.querySelector('.v2-list-head');
  while (container.lastChild && container.lastChild !== header) {
    container.removeChild(container.lastChild);
  }

  const q = query.toLowerCase().trim();
  const filtered = q
    ? sessions.filter(s =>
        (s.name || '').toLowerCase().includes(q)
        || (s.site?.name || '').toLowerCase().includes(q)
        || (s.site?.origin || '').toLowerCase().includes(q)
      )
    : sessions;

  const countEl = document.getElementById('sessionCount');
  if (countEl) countEl.textContent = String(filtered.length);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'v2-empty';

    if (sessions.length === 0) {
      const iconWrap = document.createElement('div');
      iconWrap.className = 'v2-empty-icon';
      iconWrap.innerHTML = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M8 2l1.2 3.8L13 7l-3.8 1.2L8 12 6.8 8.2 3 7l3.8-1.2L8 2Z" fill="currentColor"/></svg>';
      const title = document.createElement('div');
      title.className = 'v2-empty-title';
      title.textContent = localizer.getMessage('emptyNoProfilesTitle') || 'No profiles yet';
      const sub = document.createElement('div');
      sub.className = 'v2-empty-sub';
      sub.textContent = localizer.getMessage('emptyNoProfilesSub') || 'Create one above to start isolating accounts.';
      empty.append(iconWrap, title, sub);
    } else {
      const title = document.createElement('div');
      title.className = 'v2-empty-title';
      title.textContent = localizer.getMessage('emptyNoMatchesTitle') || 'No matches';
      const sub = document.createElement('div');
      sub.className = 'v2-empty-sub';
      sub.textContent = localizer.getMessage('emptyNoMatchesSub') || 'Try a different search.';
      empty.append(title, sub);
    }

    container.appendChild(empty);
    return;
  }

  const groupsEl = document.createElement('div');
  groupsEl.className = 'v2-site-groups';
  container.appendChild(groupsEl);

  const groups = new Map<string, { site: PopupSession['site']; sessions: PopupSession[] }>();
  for (const session of filtered) {
    const key = profileSiteKey(session.site);
    const group = groups.get(key) ?? { site: session.site, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }

  let groupIndex = 0;
  groups.forEach((group, key) => {
    const section = document.createElement('section');
    section.className = 'v2-site-group';
    section.dataset.siteKey = key;

    const collapsed = collapsedSites.has(key);
    if (collapsed) section.classList.add('collapsed');

    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'v2-site-heading';
    heading.setAttribute('aria-expanded', String(!collapsed));

    const headingText = document.createElement('span');
    headingText.className = 'v2-site-heading-text';
    const siteName = document.createElement('strong');
    siteName.textContent = group.site?.name || localizer.getMessage('unassignedSite') || 'Unassigned';
    const siteAddress = document.createElement('span');
    siteAddress.textContent = group.site?.origin || localizer.getMessage('unassignedSiteAddress') || 'Profiles without a creation site';
    headingText.append(siteName, siteAddress);

    const chevron = document.createElement('span');
    chevron.className = 'v2-site-chevron';
    chevron.textContent = '⌄';
    chevron.setAttribute('aria-hidden', 'true');
    heading.append(headingText, chevron);

    const profileList = document.createElement('div');
    profileList.className = 'v2-site-profiles';
    profileList.hidden = collapsed;
    const groupId = `site-profiles-${groupIndex++}`;
    heading.setAttribute('aria-controls', groupId);
    profileList.id = groupId;

    heading.addEventListener('click', () => {
      const next = !section.classList.contains('collapsed');
      section.classList.toggle('collapsed', next);
      profileList.hidden = next;
      heading.setAttribute('aria-expanded', String(!next));
      if (next) collapsedSites.add(key);
      else collapsedSites.delete(key);
    });

    section.append(heading, profileList);
    groupsEl.appendChild(section);

    group.sessions.forEach((session, i) => {
      const isActive = session.id === currentSessionId;
      const hue = getSessionHue(session, i);
      const displayName = session.name || session.id;

      const card = document.createElement('div');
      card.className = 'v2-card' + (isActive ? ' active' : '');
      card.style.setProperty('--hue', String(hue));
      card.style.setProperty('--i', String(i));

      // Color dot — dispatches sessionColorChanged so popup.ts can update the hero
      const colorDot = buildColorDot(session, card, (newHue) => {
        card.dispatchEvent(new CustomEvent('sessionColorChanged', {
          bubbles: true,
          detail: { sessionId: session.id, hue: newHue }
        }));
      }, localizer);

      const bar = document.createElement('div');
      bar.className = 'v2-card-bar';

      const mark = document.createElement('div');
      mark.className = 'v2-card-mark';
      const dot = document.createElement('span');
      dot.className = 'v2-card-mark-dot';
      mark.appendChild(dot);

      const body = document.createElement('div');
      body.className = 'v2-card-body';

      const nameEl = document.createElement('div');
      nameEl.className = 'v2-card-name';
      nameEl.dir = 'auto'; // user-supplied name: isolate its own direction from the surrounding UI
      nameEl.textContent = displayName;
      nameEl.title = displayName;
      body.appendChild(nameEl);

      if (isActive) {
        const meta = document.createElement('div');
        meta.className = 'v2-card-meta';
        const pill = document.createElement('span');
        pill.className = 'v2-card-active-pill';
        const liveDot = document.createElement('span');
        liveDot.className = 'v2-live-dot';
        pill.appendChild(liveDot);
        pill.appendChild(document.createTextNode(localizer.getMessage('activeStatusPill') || 'active'));
        meta.appendChild(pill);
        body.appendChild(meta);
      }

      const actions = document.createElement('div');
      actions.className = 'v2-card-actions';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'v2-card-open';
      openBtn.title = localizer.getMessage('openProfileTitle') || 'Open profile';
      openBtn.setAttribute('data-action', 'open-profile');
      openBtn.setAttribute('aria-label', localizer.getMessage('openProfileAriaLabel', [displayName]) || 'Open profile ' + displayName);
      openBtn.textContent = localizer.getMessage('openProfileButton') || 'Open';
      openBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        openBtn.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({
            action: 'createSessionTab',
            payload: { url: session.site?.url || currentUrl, sessionId: session.id }
          }) as { error?: string } | null;
          if (response?.error) {
            // The background refused (profile deleted out of band, bad URL).
            // Keep the popup open so the click is not a silent no-op.
            openBtn.disabled = false;
            console.error('[SessionShift] Failed to open profile', response.error);
            return;
          }
          window.close();
        } catch (error) {
          openBtn.disabled = false;
          console.error('[SessionShift] Failed to open profile', error);
        }
      });
      actions.appendChild(openBtn);

      const dupBtn = document.createElement('button');
      dupBtn.className = 'v2-card-dup';
      dupBtn.title = localizer.getMessage('duplicateProfileTitle') || 'Duplicate profile';
      dupBtn.setAttribute('data-action', 'duplicate-profile');
      dupBtn.setAttribute('aria-label', localizer.getMessage('duplicateProfileAriaLabel', [displayName]) || `Duplicate profile ${displayName}`);
      dupBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 11H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      dupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        dupBtn.disabled = true;
        await chrome.runtime.sendMessage({ action: 'duplicateSession', payload: { sessionId: session.id } });
        const fresh = await getSavedSessions();
        renderSessionList(container, fresh, currentSessionId, tabId, currentUrl, localizer, query);
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'v2-card-rename';
      renameBtn.title = localizer.getMessage('renameTitle') || 'Rename';
      renameBtn.setAttribute('data-action', 'rename-profile');
      renameBtn.setAttribute('aria-label', localizer.getMessage('renameAriaLabel', [displayName]) || `Rename profile ${displayName}`);
      renameBtn.innerHTML = RENAME_ICON;
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRename(card, renameBtn, session, tabId, currentSessionId);
      });

      actions.appendChild(dupBtn);
      actions.appendChild(renameBtn);

    // The active profile is marked by its ACTIVE pill and tinted border; it
    // gets no delete button (deleting the profile this tab is using is not
    // offered from the popup).
      if (!isActive) {
        const delBtn = document.createElement('button');
        delBtn.className = 'v2-card-del';
        delBtn.title = localizer.getMessage('deleteTitle') || 'Delete';
        delBtn.setAttribute('data-action', 'delete-profile');
        delBtn.setAttribute('aria-label', localizer.getMessage('deleteAriaLabel', [displayName]) || `Delete profile ${displayName}`);
        delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          startDeleteConfirm(actions, [dupBtn, renameBtn, delBtn], async () => {
            await chrome.runtime.sendMessage({ action: 'deleteSession', payload: { sessionId: session.id } });
            const current = await getSavedSessions();
            await setSavedSessions(current.filter(s => s.id !== session.id));
            await new Promise<void>(resolve => chrome.storage.local.remove([`cookies_${session.id}`], resolve));
            // The background purged this profile's favorites; tell the favorites
            // section to re-read so it stops showing rows for them.
            document.dispatchEvent(new CustomEvent('favoritesChanged'));
            const remaining = await getSavedSessions();
            renderSessionList(container, remaining, currentSessionId, tabId, currentUrl, localizer, query);
          }, localizer);
        });
        actions.appendChild(delBtn);
      }

      card.appendChild(colorDot);
      card.appendChild(bar);
      card.appendChild(mark);
      card.appendChild(body);
      card.appendChild(actions);
      attachOpenInTabMenu(card, session, () => currentUrl, localizer);

      if (!isActive) {
        card.addEventListener('click', () => {
          chrome.runtime.sendMessage({ action: 'setSession', payload: { tabId, sessionId: session.id } })
            // Bypass cache on switch: the disk cache is shared across every
            // profile (they're cookie jars within one real Chrome profile, not
            // separate browser profiles), so a cached response fetched under
            // the previous profile's cookies could otherwise render here on a
            // plain reload if the server never sent `Vary: Cookie`.
            .then(() => { chrome.tabs.reload(tabId, { bypassCache: true }); window.close(); });
        });
      }

      profileList.appendChild(card);
    });
  });
}
