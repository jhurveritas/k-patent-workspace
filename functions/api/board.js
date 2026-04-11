export async function onRequest(context) {
  const allowedOrigins = [
    "https://k-patent-workspace.pages.dev",
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:5500"
  ];

  const origin = context.request.headers.get("Origin");
  const isAllowedOrigin = allowedOrigins.includes(origin);

  const corsHeaders = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", // 💡 DELETE 메서드 허용 추가
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (isAllowedOrigin) {
    corsHeaders["Access-Control-Allow-Origin"] = origin;
  }

  if (context.request.method === "OPTIONS") {
    if (isAllowedOrigin) return new Response(null, { headers: corsHeaders });
    else return new Response(null, { status: 403 }); 
  }

  const db = context.env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "데이터베이스(D1)가 연결되지 않았습니다." }), { 
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  try {
    // =========================================================
    // [GET] 게시글 불러오기
    // =========================================================
    if (context.request.method === "GET") {
      const { results } = await db.prepare(`
        SELECT * FROM posts 
        ORDER BY is_announcement DESC, created_at DESC 
        LIMIT 50
      `).all();
      return new Response(JSON.stringify(results), { 
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // =========================================================
    // [POST] 게시글 등록하기
    // =========================================================
    if (context.request.method === "POST") {
      const body = await context.request.json();
      const content = body.content;
      const adminKey = body.admin_key;

      if (!content || content.trim() === "") {
        return new Response(JSON.stringify({ error: "내용이 비어 있습니다." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const expectedAdminKey = context.env.ADMIN_KEY;
      const isAnnouncement = (expectedAdminKey && adminKey === expectedAdminKey) ? 1 : 0;

      await db.prepare("INSERT INTO posts (content, is_announcement) VALUES (?, ?)").bind(content, isAnnouncement).run();

      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // =========================================================
    // 🗑️ [DELETE] 게시글 삭제하기 (추가된 부분)
    // =========================================================
    if (context.request.method === "DELETE") {
      const body = await context.request.json();
      const id = body.id;
      const adminKey = body.admin_key;
      const expectedAdminKey = context.env.ADMIN_KEY;

      // 비밀번호가 틀리거나 없으면 거절
      if (!expectedAdminKey || adminKey !== expectedAdminKey) {
        return new Response(JSON.stringify({ error: "관리자 비밀번호가 틀립니다." }), { 
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      // 비밀번호가 맞으면 해당 ID의 글 삭제
      await db.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();

      return new Response(JSON.stringify({ success: true }), { 
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    return new Response(JSON.stringify({ error: "잘못된 요청 방식입니다." }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: "서버 에러: " + err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
