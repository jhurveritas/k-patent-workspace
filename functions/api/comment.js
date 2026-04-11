export async function onRequest(context) {
  const allowedOrigins = ["https://k-patent-workspace.pages.dev", "http://localhost:8788", "http://127.0.0.1:8788"];
  const origin = context.request.headers.get("Origin");
  const corsHeaders = { "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (allowedOrigins.includes(origin)) corsHeaders["Access-Control-Allow-Origin"] = origin;
  if (context.request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const db = context.env.DB;
  if (!db) return new Response(JSON.stringify({ error: "DB 연결 안됨" }), { status: 500, headers: corsHeaders });

  try {
    // 특정 게시글(post_id)의 댓글 모두 불러오기
    if (context.request.method === "GET") {
      const url = new URL(context.request.url);
      const postId = url.searchParams.get("post_id");
      const { results } = await db.prepare("SELECT id, post_id, parent_id, content, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC").bind(postId).all();
      return new Response(JSON.stringify(results), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 댓글 / 대댓글 달기
    if (context.request.method === "POST") {
      const { post_id, parent_id, content, password, admin_key } = await context.request.json();
      if (!content) return new Response(JSON.stringify({ error: "내용 없음" }), { status: 400, headers: corsHeaders });
      
      const expectedAdminKey = context.env.ADMIN_KEY;
      const finalPassword = (expectedAdminKey && admin_key === expectedAdminKey) ? expectedAdminKey : password;

      await db.prepare("INSERT INTO comments (post_id, parent_id, content, password) VALUES (?, ?, ?, ?)").bind(post_id, parent_id || null, content, finalPassword || null).run();
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    // 댓글 삭제
    if (context.request.method === "DELETE") {
      const { id, secret_key } = await context.request.json();
      const expectedAdminKey = context.env.ADMIN_KEY;
      
      const comment = await db.prepare("SELECT password FROM comments WHERE id = ?").bind(id).first();
      if (!comment) return new Response(JSON.stringify({ error: "댓글 없음" }), { status: 404, headers: corsHeaders });

      const isAdmin = (expectedAdminKey && secret_key === expectedAdminKey);
      const isAuthor = (comment.password && secret_key === comment.password);

      if (!isAdmin && !isAuthor) return new Response(JSON.stringify({ error: "권한 없음" }), { status: 403, headers: corsHeaders });

      // 댓글 삭제 시, 그 아래 달린 대댓글도 함께 삭제
      await db.prepare("DELETE FROM comments WHERE parent_id = ?").bind(id).run();
      await db.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "잘못된 요청" }), { status: 405, headers: corsHeaders });
  } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders }); }
}
