// Inviting people: the table's link to copy, and the same link as a QR code to scan from a phone.
// QR codes come from qrcode-generator (the global `qrcode`, loaded in index.html).
let pop = null;

export function closeShare() { pop?.remove(); pop = null; }

export function openShare(anchor) {
  if (pop) { closeShare(); return; }
  const url = location.href;
  pop = document.createElement("div");
  pop.className = "ct-menu ct-share";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Invite people");
  pop.innerHTML = `
    <div class="ct-pop">
      <div class="ct-share-title">Invite people</div>
      <div class="ct-pop-title">Anyone with this link sits down at your table.</div>
      <div class="ct-share-row">
        <input class="ct-share-url" readonly value="${url.replace(/"/g, "&quot;")}" aria-label="Table link" />
        <button class="ct-act ct-act-ink" data-copy>Copy link</button>
      </div>
      <div class="ct-qr" aria-label="QR code of the table link">${qrSvg(url)}</div>
      ${navigator.share ? `<button class="ct-act" data-native>Share…</button>` : ""}
    </div>`;
  document.body.appendChild(pop);
  const input = pop.querySelector("input"), copy = pop.querySelector("[data-copy]");
  input.addEventListener("focus", () => input.select());
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); } catch { input.select(); document.execCommand?.("copy"); }
    copy.textContent = "Copied";
    setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy link"; }, 1600);
  });
  pop.querySelector("[data-native]")?.addEventListener("click", () => navigator.share({ title: "Card Table", url }).catch(() => {}));
  // above the button that opened it, kept on screen
  const a = anchor.getBoundingClientRect(), r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(a.left + a.width / 2 - r.width / 2, innerWidth - r.width - 8))}px`;
  pop.style.top = `${Math.max(8, a.top - r.height - 10)}px`;
  setTimeout(() => {
    addEventListener("pointerdown", function away(e) {
      if (!pop || pop.contains(e.target) || anchor.contains(e.target)) { if (!pop) removeEventListener("pointerdown", away); return; }
      closeShare(); removeEventListener("pointerdown", away);
    });
  });
}

function qrSvg(text) {
  if (typeof qrcode !== "function") return "";
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
