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

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse

from ..config import CONFIG
from . import db
from .auth import verify_token
from .whats import _base_url

router = APIRouter(prefix="/admin", tags=["admin"])

PAGE = """<!doctype html>
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
async function api(path,opts){const r=await fetch(path,opts);if(!r.ok)throw new Error(await r.text());return r.json()}
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
refresh();setInterval(refresh,3000);
</script></body></html>"""


def _admin(user: str = Depends(verify_token)) -> str:
    expected = os.environ.get("STOCKLINE_ADMIN_USER", "manager")
    if user != expected:
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


@router.get("", response_class=HTMLResponse)
async def index(_: str = Depends(_admin)) -> HTMLResponse:
    return HTMLResponse(PAGE)


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
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(f"{_base_url()}/qr")
        response.raise_for_status()
        return dict(response.json())


@router.post("/whatsapp/connect")
async def wa_connect(_: str = Depends(_admin)) -> dict[str, str]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(f"{_base_url()}/connect")
        response.raise_for_status()
        return dict(response.json())


@router.post("/whatsapp/disconnect")
async def wa_disconnect(_: str = Depends(_admin)) -> dict[str, str]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(f"{_base_url()}/disconnect")
        response.raise_for_status()
        return dict(response.json())


@router.get("/config")
async def get_config(_: str = Depends(_admin)) -> dict[str, Any]:
    return {
        "selection": CONFIG.selection,
        "settings": CONFIG.settings,
        "runtime": CONFIG.runtime,
    }


@router.post("/config")
async def set_config(payload: dict[str, Any], _: str = Depends(_admin)) -> dict[str, str]:
    path = CONFIG.config_path
    backup = Path("/tmp") / f"config.jsonc.{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}.bak"
    backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("selection", "settings", "runtime"):
        if key in payload:
            data[key] = payload[key]
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"status": "updated", "backup": str(backup)}


@router.get("/products")
async def list_products(_: str = Depends(_admin)) -> list[dict[str, Any]]:
    return await db.fetch_products()


@router.post("/products")
async def create_product(payload: dict[str, Any], _: str = Depends(_admin)) -> dict[str, str]:
    await db.pool().execute(
        "INSERT INTO product(product_id,product_name,price,stock) VALUES($1,$2,$3,$4) "
        "ON CONFLICT(product_id) DO UPDATE SET product_name=$2,price=$3,stock=$4",
        payload["product_id"],
        payload["product_name"],
        float(payload["price"]),
        float(payload["stock"]),
    )
    return {"status": "ok"}


@router.get("/clients")
async def list_clients(_: str = Depends(_admin)) -> list[dict[str, Any]]:
    rows = await db.pool().fetch(
        "SELECT client_id, phone_number, client_name FROM client ORDER BY client_id"
    )
    return [dict(r) for r in rows]


@router.post("/clients")
async def create_client(payload: dict[str, Any], _: str = Depends(_admin)) -> dict[str, str]:
    await db.pool().execute(
        "INSERT INTO client(client_id,phone_number,client_name) VALUES($1,$2,$3) "
        "ON CONFLICT(client_id) DO UPDATE SET phone_number=$2,client_name=$3",
        payload["client_id"],
        payload["phone_number"],
        payload["client_name"],
    )
    return {"status": "ok"}


@router.get("/config/download")
async def download_config(_: str = Depends(_admin)) -> HTMLResponse:
    content = CONFIG.config_path.read_text(encoding="utf-8")
    return HTMLResponse(f"<pre>{content}</pre>")
