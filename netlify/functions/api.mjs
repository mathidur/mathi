import { getStore } from "@netlify/blobs";

// Esta funcion atiende /api/* (datos) y /_blob/* (imagenes subidas)
export const config = { path: ["/api/*", "/_blob/*"] };

const store = getStore({ name: "jujupelis", consistency: "strong" });
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLS = new Set(["movies", "decor", "votes", "config"]);

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const isAdmin = (req) => {
  const p = process.env.ADMIN_PASSWORD;
  return !!p && req.headers.get("x-admin") === p;
};

export default async (req) => {
  const path = new URL(req.url).pathname;
  const m = req.method;
  try {
    // Archivos subidos (portadas, decoracion, fondo, jumpscare)
    if (path.startsWith("/_blob/")) {
      const id = path.slice(7);
      if (!ID.test(id)) return new Response("not found", { status: 404 });
      const f = await store.getWithMetadata("f/" + id, { type: "arrayBuffer" });
      if (!f) return new Response("not found", { status: 404 });
      return new Response(f.data, {
        headers: {
          "content-type": f.metadata?.type || "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (path === "/api/auth") return json({ ok: isAdmin(req) });

    // Todo el estado de una vez (el sitio lo consulta cada pocos segundos)
    if (path === "/api/state" && m === "GET") {
      const { blobs } = await store.list({ prefix: "d/" });
      const docs = {};
      await Promise.all(
        blobs.map(async (b) => {
          docs[b.key.slice(2)] = await store.get(b.key, { type: "json" });
        })
      );
      return json({ docs });
    }

    if (path.startsWith("/api/doc/")) {
      const p = path.slice(9);
      const [col, id, extra] = p.split("/");
      if (!COLS.has(col) || !ID.test(id || "") || extra) return json({ error: "Ruta invalida" }, 400);
      const key = "d/" + p;

      if (m === "DELETE") {
        if (!isAdmin(req)) return json({ error: "No autorizado" }, 403);
        await store.delete(key);
        return json({ ok: true });
      }

      if (m === "PUT") {
        const body = await req.json();
        const data = body && typeof body.data === "object" && body.data ? body.data : null;
        if (!data) return json({ error: "Datos invalidos" }, 400);

        // Cualquiera puede votar (si la votacion esta abierta); lo demas es solo admin
        if (col === "votes" && !isAdmin(req)) {
          const main = await store.get("d/config/main", { type: "json" });
          if (!main?.open) return json({ error: "La votacion esta cerrada" }, 403);
          const mid = data.movieId;
          const movie = typeof mid === "string" && ID.test(mid) ? await store.get("d/movies/" + mid, { type: "json" }) : null;
          if (!movie) return json({ error: "Esa pelicula no existe" }, 400);
          await store.setJSON(key, { movieId: mid, at: Date.now() });
          return json({ ok: true });
        }

        if (!isAdmin(req)) return json({ error: "No autorizado" }, 403);
        const cur = body.merge ? (await store.get(key, { type: "json" })) || {} : {};
        await store.setJSON(key, { ...cur, ...data });
        return json({ ok: true });
      }
    }

    if (path === "/api/upload" && m === "POST") {
      if (!isAdmin(req)) return json({ error: "No autorizado" }, 403);
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 5.5 * 1024 * 1024) return json({ error: "El archivo pesa mas de 5 MB" }, 413);
      const id = crypto.randomUUID().replace(/-/g, "");
      await store.set("f/" + id, buf, {
        metadata: { type: req.headers.get("content-type") || "application/octet-stream" },
      });
      return json({ id, url: "/_blob/" + id });
    }

    if (path.startsWith("/api/file/") && m === "DELETE") {
      if (!isAdmin(req)) return json({ error: "No autorizado" }, 403);
      const id = path.slice(10);
      if (!ID.test(id)) return json({ error: "Id invalido" }, 400);
      await store.delete("f/" + id);
      return json({ ok: true });
    }

    return json({ error: "No encontrado" }, 404);
  } catch (e) {
    return json({ error: e.message || "Error" }, 500);
  }
};
