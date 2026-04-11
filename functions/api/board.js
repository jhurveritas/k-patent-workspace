export async function onRequest(context) {
  // 1. 허용할 도메인 목록 (기존 코드와 완벽히 동일하게 유지)
  const allowedOrigins = [
    "https://k-patent-workspace.pages.dev",
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:5500"
  ];

  const origin = context.request.headers.get("Origin");
  const isAllowedOrigin = allowedOrigins.includes(origin);

  // CORS 헤더 설정
  const corsHeaders = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (isAllowedOrigin) {
    corsHeaders["Access-Control-Allow-Origin"] = origin;
  }

  // OPTIONS (Preflight) 요청 처리
  if (context.request.method === "OPTIONS") {
    if (isAllowedOrigin) {
      return new Response(null, { headers: corsHeaders });
    } else {
      return new Response(null, { status: 403 }); 
    }
  }

  // 2. D1 데이터베이스 바인딩 확인
  // (wrangler.toml에서 binding = "DB" 로 설정했다면 context.env.DB 로 접근)
  const db = context.env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "데이터베이스(D1)가 연결되지 않았습니다." }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }

  try {
    // =========================================================
    // [GET] 게시글 불러오기
    // =========================================================
    if (context.request.method === "GET") {
      // is_announcement가 1(true)인 공지사항을 먼저 띄우고, 그다음 작성일(created_at) 최신순으로 50개 정렬
      const { results } = await db.prepare(`
        SELECT * FROM posts 
        ORDER BY is_announcement DESC, created_at DESC 
        LIMIT 50
      `).all();
      
      return new Response(JSON.stringify(results), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
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
        return new Response(JSON.stringify({ error: "내용이 비어 있습니다." }), { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      // 프론트에서 보낸 비밀번호와 클라우드플레어 환경변수(ADMIN_KEY)가 일치하는지 확인
      const expectedAdminKey = context.env.ADMIN_KEY;
      
      // 일치하면 공지사항(1), 아니면 일반글(0)
      const isAnnouncement = (expectedAdminKey && adminKey === expectedAdminKey) ? 1 : 0;

      // DB에 데이터 삽입
      await db.prepare(
        "INSERT INTO posts (content, is_announcement) VALUES (?, ?)"
      ).bind(content, isAnnouncement).run();

      return new Response(JSON.stringify({ success: true }), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // GET이나 POST가 아닌 잘못된 요청일 경우
    return new Response(JSON.stringify({ error: "잘못된 요청 방식입니다." }), { 
      status: 405, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "서버 에러: " + err.message }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}
