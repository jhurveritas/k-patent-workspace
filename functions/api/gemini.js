export async function onRequest(context) {
  // 💡 1. 허용할 도메인 목록 (실제 도메인과 로컬 테스트 주소를 모두 입력하세요)
  const allowedOrigins = [
    "https://my-patent-pro.pages.dev", // 예: Cloudflare Pages 배포 주소 (여기를 진짜 주소로 바꾸세요!)
    "http://localhost:8788",           // 로컬 개발 환경 (Wrangler 기본 포트)
    "http://127.0.0.1:8788",
    "http://localhost:5500"            // Live Server 등을 쓸 경우 해당 포트
  ];

  const origin = context.request.headers.get("Origin");
  const isAllowedOrigin = allowedOrigins.includes(origin);

  // 💡 2. Preflight (OPTIONS 요청) 사전 차단 및 응답
  if (context.request.method === "OPTIONS") {
    if (isAllowedOrigin) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    } else {
      // 허용되지 않은 도메인에서 온 OPTIONS 요청은 바로 거절
      return new Response(null, { status: 403 }); 
    }
  }

  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API 키가 설정되지 않았습니다." }), { status: 400 });
    }

    const requestBody = await context.request.json();
    
    // 임시로 안정적인 3.1 Pro 모델을 사용합니다.
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const response = new Response(googleResponse.body, googleResponse);
    
    // 💡 3. 본 요청(POST)에 대한 CORS 헤더 설정
    if (isAllowedOrigin) {
      response.headers.set('Access-Control-Allow-Origin', origin);
    }

    return response;

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 에러: " + err.message }), { status: 500 });
  }
}
