export async function onRequest(context) {
  const allowedOrigins = ["https://k-patent-workspace.pages.dev", "http://localhost:8788", "http://127.0.0.1:8788"];
  const origin = context.request.headers.get("Origin");
  const corsHeaders = { "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (allowedOrigins.includes(origin)) corsHeaders["Access-Control-Allow-Origin"] = origin;
  if (context.request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const db = context.env.DB;
  if (!db) return new Response(JSON.stringify({ error: "DB 연결 안됨" }), { status: 500, headers: corsHeaders });

  try {
    // 💡 [GET] 게시글 + 댓글 개수 함께 불러오기
    if (context.request.method === "GET") {
      const { results } = await db.prepare(`
        SELECT p.id, p.content, p.is_announcement, p.created_at, COUNT(c.id) as comment_count 
        FROM posts p LEFT JOIN comments c ON p.id = c.post_id 
        GROUP BY p.id ORDER BY p.is_announcement DESC, p.created_at DESC LIMIT 50
      `).all();
      return new Response(JSON.stringify(results), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (context.request.method === "POST") {
      const { content, admin_key, password } = await context.request.json();
      if (!content) return new Response(JSON.stringify({ error: "내용 없음" }), { status: 400, headers: corsHeaders });
      const isAnnouncement = (context.env.ADMIN_KEY && admin_key === context.env.ADMIN_KEY) ? 1 : 0;
      await db.prepare("INSERT INTO posts (content, is_announcement, password) VALUES (?, ?, ?)").bind(content, isAnnouncement, password || null).run();
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    if (context.request.method === "PUT") {
      const { id, content, secret_key } = await context.request.json();
      const post = await db.prepare("SELECT password FROM posts WHERE id = ?").bind(id).first();
      if (!post) return new Response(JSON.stringify({ error: "게시글 없음" }), { status: 404, headers: corsHeaders });
      if ((!context.env.ADMIN_KEY || secret_key !== context.env.ADMIN_KEY) && secret_key !== post.password) return new Response(JSON.stringify({ error: "권한 없음" }), { status: 403, headers: corsHeaders });
      await db.prepare("UPDATE posts SET content = ? WHERE id = ?").bind(content, id).run();
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    if (context.request.method === "DELETE") {
      const { id, secret_key } = await context.request.json();
      const post = await db.prepare("SELECT password FROM posts WHERE id = ?").bind(id).first();
      if (!post) return new Response(JSON.stringify({ error: "게시글 없음" }), { status: 404, headers: corsHeaders });
      if ((!context.env.ADMIN_KEY || secret_key !== context.env.ADMIN_KEY) && secret_key !== post.password) return new Response(JSON.stringify({ error: "권한 없음" }), { status: 403, headers: corsHeaders });
      
      // 💡 게시글 삭제 시 하위 댓글들도 연쇄 삭제
      await db.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
      await db.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ error: "잘못된 요청" }), { status: 405, headers: corsHeaders });
  } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders }); }
}
