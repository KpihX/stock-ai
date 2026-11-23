"""Lightweight back-office integrated in the FastAPI service.

One file, one auth, one database. Inspired by the kpihx-labs Django admin:
a setup dashboard, list views and actions. No second framework.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
import httpx
import json5
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from ..config import get_config as load_live_config
from . import db
from .auth import hash_password, require_admin, verify_token
from .errors import sanitize_error
from .events import BUS
from .whats import _base_url

router = APIRouter(prefix="/admin", tags=["admin"])
ADMIN_ASSETS = Path(__file__).parent / "admin_assets"
PAGE = (ADMIN_ASSETS / "index.html").read_text(encoding="utf-8")

_LEGACY_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stockline Admin</title>
<style>
body{margin:0;font:14px system-ui;background:#0d1117;color:#c9d1d9}
header{padding:14px 22px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between}
h1{font-size:16px;margin:0;letter-spacing:1px}
main{max-width:1000px;margin:24px auto;padding:0 18px}
section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
h2{font-size:13px;text-transform:uppercase;color:#8b949e;margin:0 0 12px}
table{width:100%;border-collapse:collapse}td,th{padding:7px;border-bottom:1px solid #30363d;text-align:left}
button,input{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;padding:6px 10px}
button{cursor:pointer}button:hover{background:#30363d}
.badge{padding:3px 8px;border-radius:10px;background:#238636;color:#fff}
.off{background:#6e7681}.warn{background:#9e6a03}
#qr img{width:180px;height:180px}
pre{white-space:pre-wrap;font-size:12px;color:#8b949e}
</style></head><body>
<header><h1>STOCKLINE · ADMIN</h1><span>Setup & back-office</span></header>
<main>
<section id="login"><h2>Admin login</h2>
<form onsubmit="doLogin(event)">
<input id="admin-user" placeholder="admin" value="admin" required>
<input id="admin-pass" type="password" placeholder="password" required>
<button type="submit">Sign in</button></form>
<p id="login-error"></p></section>
<section><h2>WhatsApp</h2>
<p>Status: <span id="wa-status" class="badge off">loading</span> · <span id="wa-phone"></span></p>
<div id="qr"></div>
<p><button onclick="waAction('connect')">Connect / refresh QR</button>
<button onclick="waAction('disconnect')">Disconnect</button></p></section>
<section><h2>Configuration</h2><pre id="config"></pre>
<p><button onclick="location.href='/admin/config/download'">Download config.jsonc</button></p></section>
<section><h2>Products</h2><table id="products"></table>
<form onsubmit="addProduct(event)"><input name="id" placeholder="ART-X" required>
<input name="name" placeholder="Product name" required>
<input name="price" placeholder="Price" type="number" step="0.01" required>
<input name="stock" placeholder="Stock" type="number" step="0.01" required>
<button>Add product</button></form></section>
<section><h2>Clients</h2><table id="clients"></table>
<form onsubmit="addClient(event)"><input name="id" placeholder="CLI-0045" required>
<input name="phone" placeholder="33600000000" required>
<input name="name" placeholder="Client name" required><button>Add client</button></form></section>
</main>
<script>
let TOKEN = new URLSearchParams(location.hash.slice(1)).get("token") || localStorage.getItem("stockline_admin_token") || "";
function authHeaders(extra){const h=Object.assign({},extra||{}); if(TOKEN) h.Authorization="Bearer "+TOKEN; return h}
async function api(path,opts){opts=opts||{};opts.headers=authHeaders(opts.headers);const r=await fetch(path,opts);if(r.status===401){showLogin();throw new Error("Unauthorized")}if(!r.ok)throw new Error(await r.text());return r.json()}
function showLogin(){const el=document.getElementById("login");if(el)el.style.display="block"}
async function doLogin(event){event.preventDefault();const u=document.getElementById("admin-user").value;const p=document.getElementById("admin-pass").value;const r=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})});if(!r.ok){document.getElementById("login-error").textContent="Invalid credentials";return}const data=await r.json();TOKEN=data.token;localStorage.setItem("stockline_admin_token",TOKEN);document.getElementById("login").style.display="none";document.getElementById("login-error").textContent="";refresh()}
async function refresh(){
 const s=await api('/admin/whatsapp/status');
 const el=document.getElementById('wa-status');el.textContent=s.status;
 el.className='badge '+(s.status==='connected'?'':(s.status==='qr_pending'?'warn':'off'));
 document.getElementById('wa-phone').textContent=s.phone||'';
 const qr=document.getElementById('qr');
 if(s.qr_ready){const q=await api('/admin/whatsapp/qr');qr.innerHTML='<img src="'+q.qr+'" alt="QR">'}
 else qr.innerHTML='';
 document.getElementById('config').textContent=JSON.stringify(await api('/admin/config'),null,2);
 document.getElementById('products').innerHTML='<tr><th>ID</th><th>Name</th><th>Price</th><th>Stock</th></tr>'+
  (await api('/admin/products')).map(p=>'<tr><td>'+p.product_id+'</td><td>'+p.product_name+'</td><td>'+p.price+'</td><td>'+p.stock+'</td></tr>').join('');
 document.getElementById('clients').innerHTML='<tr><th>ID</th><th>Phone</th><th>Name</th></tr>'+
  (await api('/admin/clients')).map(c=>'<tr><td>'+c.client_id+'</td><td>'+c.phone_number+'</td><td>'+c.client_name+'</td></tr>').join('');
}
async function waAction(action){await api('/admin/whatsapp/'+action,{method:'POST'});setTimeout(refresh,1500)}
async function addProduct(e){e.preventDefault();const f=new FormData(e.target);
 await api('/admin/products',{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({product_id:f.get('id'),product_name:f.get('name'),price:+f.get('price'),stock:+f.get('stock')})});
 e.target.reset();refresh()}
async function addClient(e){e.preventDefault();const f=new FormData(e.target);
 await api('/admin/clients',{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({client_id:f.get('id'),phone_number:f.get('phone'),client_name:f.get('name')})});
 e.target.reset();refresh()}
if(TOKEN){document.getElementById("login").style.display="none";refresh();setInterval(refresh,3000)}else{showLogin()}
</script></body></html>"""


def _staff(user: str = Depends(verify_token)) -> str:
    return user


def _admin(user: str = Depends(require_admin)) -> str:
    return user


@router.get("")
async def index() -> RedirectResponse:
    frontend_url = os.environ.get("STOCKLINE_FRONTEND_URL", "http://localhost:5173/")
    return RedirectResponse(url=frontend_url, status_code=307)


@router.get("/assets/{filename}")
async def admin_asset(filename: str) -> FileResponse:
    if Path(filename).name != filename:
        raise HTTPException(status_code=404, detail="Not found")
    path = ADMIN_ASSETS / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)


@router.get("/whatsapp/status")
async def wa_status(_: str = Depends(_admin)) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{_base_url()}/status")
            response.raise_for_status()
            return dict(response.json())
    except httpx.HTTPError:
        return {"status": "unavailable", "phone": "", "qr_ready": False}


@router.get("/whatsapp/qr")
async def wa_qr(_: str = Depends(_admin)) -> dict[str, str]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{_base_url()}/qr")
            if response.status_code == 404:
                return {"qr": ""}
            response.raise_for_status()
            return dict(response.json())
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503, detail=f"WhatsApp listener unavailable: {sanitize_error(exc)}"
        ) from exc


@router.post("/whatsapp/connect")
async def wa_connect(
    payload: dict[str, Any] | None = None, _: str = Depends(_admin)
) -> dict[str, str]:
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(f"{_base_url()}/connect", json=payload or {})
            response.raise_for_status()
            data = dict(response.json())
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503, detail=f"WhatsApp listener unavailable: {sanitize_error(exc)}"
        ) from exc
    await BUS.publish({"type": "whatsapp.updated", "status": data.get("status", "connecting")})
    return data


@router.post("/whatsapp/disconnect")
async def wa_disconnect(_: str = Depends(_admin)) -> dict[str, str]:
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(f"{_base_url()}/disconnect")
            response.raise_for_status()
            data = dict(response.json())
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503, detail=f"WhatsApp listener unavailable: {sanitize_error(exc)}"
        ) from exc
    await BUS.publish({"type": "whatsapp.updated", "status": "disconnected"})
    return data


@router.get("/config")
async def get_config(_: str = Depends(_admin)) -> dict[str, Any]:
    cfg = load_live_config()
    return {
        "selection": cfg.selection,
        "settings": cfg.settings,
        "overrides": cfg.overrides,
        "runtime": cfg.runtime,
        "system_prompt": cfg.system_prompt,
        "ocr_prompt": cfg.ocr_prompt,
    }


@router.post("/config")
async def set_config(payload: dict[str, Any], _: str = Depends(_admin)) -> dict[str, str]:
    path = load_live_config().config_path
    backup = Path("/tmp") / f"config.jsonc.{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}.bak"
    raw = path.read_text(encoding="utf-8")
    backup.write_text(raw, encoding="utf-8")
    parsed = json5.loads(raw)
    data = dict(parsed) if isinstance(parsed, dict) else {}
    for key in ("selection", "settings", "overrides", "runtime", "system_prompt", "ocr_prompt"):
        if key in payload:
            data[key] = payload[key]
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    load_live_config(path)
    return {"status": "updated", "backup": str(backup)}


@router.get("/products")
async def list_products(_: str = Depends(_staff)) -> list[dict[str, Any]]:
    return await db.fetch_products()


@router.post("/products")
async def create_product(payload: dict[str, Any], _: str = Depends(_admin)) -> dict[str, str]:
    pid = str(payload.get("product_id", "")).strip()
    pname = str(payload.get("product_name", "")).strip()
    if not pid or not pname:
        raise HTTPException(status_code=400, detail="product_id and product_name required")
    try:
        price = float(payload["price"])
        stock = float(payload["stock"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400, detail="Valid numeric price and stock required"
        ) from exc
    await db.pool().execute(
        "INSERT INTO product(product_id,product_name,price,stock) VALUES($1,$2,$3,$4) "
        "ON CONFLICT(product_id) DO UPDATE SET product_name=$2,price=$3,stock=$4",
        pid,
        pname,
        price,
        stock,
    )
    await BUS.publish({"type": "product.updated", "product_id": pid})
    return {"status": "ok"}


@router.delete("/products/{product_id}")
async def remove_product(product_id: str, _: str = Depends(_admin)) -> dict[str, str]:
    deleted = await db.delete_product(product_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Product not found")
    await BUS.publish({"type": "product.updated", "product_id": product_id})
    return {"status": "deleted"}


@router.get("/clients")
async def list_clients(_: str = Depends(_staff)) -> list[dict[str, Any]]:
    rows = await db.pool().fetch(
        """SELECT cl.client_id, cl.phone_number, cl.client_name,
                  COUNT(c.command_id) AS order_count,
                  COALESCE(SUM(c.price * c.quantity), 0) AS total_spent,
                  MAX(c.recorded_at) AS last_order_at,
                  COALESCE(
                      (array_agg(c.product_id ORDER BY c.recorded_at DESC)
                       FILTER (WHERE c.product_id IS NOT NULL))[1],
                      ''
                  ) AS usual_product
           FROM client cl
           LEFT JOIN command c ON c.client_id = cl.client_id
           GROUP BY cl.client_id, cl.phone_number, cl.client_name
           ORDER BY cl.client_id"""
    )
    return [
        {
            "client_id": r["client_id"],
            "phone_number": r["phone_number"],
            "client_name": r["client_name"],
            "order_count": int(r["order_count"] or 0),
            "total_spent": float(r["total_spent"] or 0),
            "last_order_at": r["last_order_at"],
            "usual_product": r["usual_product"] or "",
        }
        for r in rows
    ]


@router.get("/clients/{client_id}/detail")
async def client_detail(client_id: str, _: str = Depends(_staff)) -> dict[str, Any]:
    client = await db.pool().fetchrow(
        "SELECT client_id, phone_number, client_name FROM client WHERE client_id = $1",
        client_id,
    )
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    stats = await db.fetch_client_stats(client_id)
    commands = await db.fetch_recent_commands(client_id, 50)
    return {
        "client": dict(client),
        "stats": stats,
        "commands": commands,
    }


@router.post("/clients")
async def create_client(payload: dict[str, Any], _: str = Depends(_admin)) -> dict[str, str]:
    cid = str(payload.get("client_id", "")).strip()
    cname = str(payload.get("client_name", "")).strip()
    phone = "".join(ch for ch in str(payload.get("phone_number", "")) if ch.isdigit())
    if not cid or not cname or not phone:
        raise HTTPException(
            status_code=400, detail="client_id, client_name and valid phone_number required"
        )
    try:
        await db.pool().execute(
            "INSERT INTO client(client_id,phone_number,client_name) VALUES($1,$2,$3) "
            "ON CONFLICT(client_id) DO UPDATE SET phone_number=$2,client_name=$3",
            cid,
            phone,
            cname,
        )
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Phone number {phone} is already assigned to another client",
        ) from exc
    await BUS.publish({"type": "client.updated", "client_id": cid})
    return {"status": "ok"}


@router.delete("/clients/{client_id}")
async def remove_client(client_id: str, _: str = Depends(_admin)) -> dict[str, str]:
    deleted = await db.delete_client(client_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Client not found")
    await BUS.publish({"type": "client.updated", "client_id": client_id})
    return {"status": "deleted"}


@router.get("/managers")
async def managers(_: str = Depends(_admin)) -> list[dict[str, Any]]:
    return await db.list_managers()


@router.post("/managers")
async def create_manager(payload: dict[str, Any], _: str = Depends(_admin)) -> dict[str, str]:
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not username or len(password) < 6:
        raise HTTPException(status_code=400, detail="username and password (min 6) required")
    await db.upsert_manager(username, hash_password(password), True)
    await BUS.publish({"type": "manager.updated", "username": username})
    return {"status": "ok"}


@router.put("/managers/{username}")
async def update_manager(
    username: str, payload: dict[str, Any], _: str = Depends(_admin)
) -> dict[str, str]:
    existing = await db.fetch_manager(username)
    if existing is None:
        raise HTTPException(status_code=404, detail="Manager not found")
    password = payload.get("password")
    active = payload.get("is_active")
    await db.upsert_manager(
        username,
        hash_password(str(password)) if password else existing["password_hash"],
        bool(active) if active is not None else bool(existing["is_active"]),
    )
    await BUS.publish({"type": "manager.updated", "username": username})
    return {"status": "ok"}


@router.delete("/managers/{username}")
async def remove_manager(username: str, _: str = Depends(_admin)) -> dict[str, str]:
    deleted = await db.delete_manager(username)
    if not deleted:
        raise HTTPException(status_code=404, detail="Manager not found")
    await BUS.publish({"type": "manager.updated", "username": username})
    return {"status": "deleted"}


@router.get("/pipeline/logs")
async def pipeline_logs(
    limit: int = Query(100, ge=1, le=300), _: str = Depends(_staff)
) -> dict[str, Any]:
    logs = await db.fetch_pipeline_logs(limit)
    return {"items": logs, "memory": BUS.history(limit)}


@router.get("/config/download")
async def download_config(_: str = Depends(_admin)) -> HTMLResponse:
    content = load_live_config().config_path.read_text(encoding="utf-8")
    return HTMLResponse(f"<pre>{content}</pre>")
