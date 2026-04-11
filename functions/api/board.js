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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (isAllowedOrigin) corsHeaders["Access-Control-Allow-Origin"] = origin;

  if (context.request.method === "OPTIONS") {
    if (isAllowedOrigin) return new Response(null, { headers: corsHeaders });
    else return new Response(null, { status: 403 }); 
  }

  const db = context.env.DB;
  if (!db) return new Response(JSON.stringify({ error: "DB 연결 안됨" }), { status: 500, headers: corsHeaders });

  try {
    // [GET] 불러오기
    if (context.request.method === "GET") {
      // 보안상 비밀번호는 빼고 프론트엔드로 보냅니다.
      const { results } = await db.prepare("SELECT id, content, is_announcement, created_at FROM posts ORDER BY is_announcement DESC, created_at DESC LIMIT 50").all();
      return new Response(JSON.stringify(results), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // [POST] 글 작성 (비밀번호 저장 추가)
    if (context.request.method === "POST") {
      const body = await context.request.json();
      const content = body.content;
      const adminKey = body.admin_key;
      const password = body.password || null; // 작성자 비밀번호

      if (!content || content.trim() === "") return new Response(JSON.stringify({ error: "내용 없음" }), { status: 400, headers: corsHeaders });

      const expectedAdminKey = context.env.ADMIN_KEY;
      const isAnnouncement = (expectedAdminKey && adminKey === expectedAdminKey) ? 1 : 0;

      // DB에 password 변수도 함께 INSERT
      await db.prepare("INSERT INTO posts (content, is_announcement, password) VALUES (?, ?, ?)").bind(content, isAnnouncement, password).run();
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    // [DELETE] 글 삭제 (권한 검사 추가)
    if (context.request.method === "DELETE") {
      const body = await context.request.json();
      const id = body.id;
      const inputSecret = body.secret_key; // 프론트에서 보낸 비밀번호(또는 관리자키)
      const expectedAdminKey = context.env.ADMIN_KEY;

      // 1. 해당 글의 실제 비밀번호를 DB에서 가져옵니다.
      const post = await db.prepare("SELECT password FROM posts WHERE id = ?").bind(id).first();
      
      if (!post) {
        return new Response(JSON.stringify({ error: "게시글을 찾을 수 없습니다." }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 2. 권한 확인: 입력한 키가 '관리자 키'이거나 '글 작성 시 입력한 비밀번호'인지 체크
      const isAdmin = (expectedAdminKey && inputSecret === expectedAdminKey);
      const isAuthor = (post.password && inputSecret === post.password);

      if (!isAdmin && !isAuthor) {
        return new Response(JSON.stringify({ error: "비밀번호가 일치하지 않거나 권한이 없습니다." }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 3. 권한이 확인되면 삭제
      await db.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "잘못된 요청" }), { status: 405, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: "서버 에러: " + err.message }), { status: 500, headers: corsHeaders });
  }
}
