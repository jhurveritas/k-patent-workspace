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
    if (!apiKey) return new Response(JSON.stringify({ error: "API 키 없음" }), { status: 400 });

    const requestBody = await context.request.json();
    
    // 💡 핵심: 구글 API로 보낼 최종 페이로드 변수
    let geminiPayload = requestBody; // 기본값 (IDS 판별기 등 기존 기능 호환성 유지용)

    // 🛡️ [청구항 대조기] 프롬프트 조립
    if (requestBody.type === 'compare') {
      const { krText, enText } = requestBody.data;
      const secretPrompt = `너는 전문 특허 번역가이자 명세사야. 아래 한국어 특허 청구항 원문과 영문 번역본을 교차 검증해서 다음 항목을 분석해줘:\n\n1. 누락되거나 잘못 번역된 구성요소\n2. 법적 권리 범위의 변동 가능성 (원문과 번역본 간의 괴리)\n3. 특허 용어(Terminology)의 적절성\n4. 종합적인 수정 제안\n\n[한국어 원문]\n${krText}\n\n[영문 번역본]\n${enText}`;
      
      geminiPayload = {
        contents: [{ role: "user", parts: [{ text: secretPrompt }] }],
        generationConfig: { temperature: 0.1 }
      };
    }
    
    // 🛡️ [의견서 생성기] 프롬프트 조립
    else if (requestBody.type === 'draft') {
      const { originalContext, userDraftResponse, userTemplate } = requestBody.data;
      const secretPrompt = `특허청 통지서 원문: ${originalContext}\n초안: ${userDraftResponse}\n템플릿: ${userTemplate}`;
      
      geminiPayload = {
        contents: [{ role: "user", parts: [{ text: secretPrompt }] }]
      };
    }

    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload) // 👈 조립된 비밀 프롬프트가 구글로 전송됨
    });

    const response = new Response(googleResponse.body, googleResponse);
    if (isAllowedOrigin) response.headers.set('Access-Control-Allow-Origin', origin);
    return response;

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 에러: " + err.message }), { status: 500 });
  }
}
