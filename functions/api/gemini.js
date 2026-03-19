export async function onRequest(context) {
  // 💡 1. 허용할 도메인 목록
  const allowedOrigins = [
    "https://my-patent-pro.pages.dev", // 실제 도메인으로 변경하세요!
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:5500"
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
      return new Response(null, { status: 403 }); 
    }
  }

  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "API 키 없음" }), { status: 400 });

    const requestBody = await context.request.json();
    let geminiPayload = requestBody; 

    // 🛡️ [청구항 대조기]
    if (requestBody.type === 'compare') {
      const { krText, enText } = requestBody.data;
      const secretPrompt = `너는 전문 특허 번역가이자 명세사야. 아래 한국어 특허 청구항 원문과 영문 번역본을 교차 검증해서 다음 항목을 분석해줘:\n\n1. 누락되거나 잘못 번역된 구성요소\n2. 법적 권리 범위의 변동 가능성 (원문과 번역본 간의 괴리)\n3. 특허 용어(Terminology)의 적절성\n4. 종합적인 수정 제안\n\n[한국어 원문]\n${krText}\n\n[영문 번역본]\n${enText}`;
      
      geminiPayload = {
        contents: [{ role: "user", parts: [{ text: secretPrompt }] }],
        generationConfig: { temperature: 0.1 }
      };
    }
    
    // 🛡️ [의견서 생성기] - '보정서 원문(amendmentContext)' 추가됨
    else if (requestBody.type === 'draft') {
      const { originalContext, amendmentContext, userDraftResponse, userTemplate } = requestBody.data;
      
      const secretPrompt = `너는 KIPO(한국특허청) 양식에 능통한 전문 특허 명세사야. 제공된 템플릿의 문체와 양식을 엄격하게 준수하여 아래 자료를 바탕으로 최종 특허 의견서/보정서를 작성해줘.\n\n[특허청 통지서 원문]\n${originalContext}\n\n[보정서 원문]\n${amendmentContext || '입력되지 않음'}\n\n[대응 초안 (핵심 논리)]\n${userDraftResponse}\n\n[작성 템플릿]\n${userTemplate}`;
      
      geminiPayload = {
        contents: [{ role: "user", parts: [{ text: secretPrompt }] }]
      };
    }

    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload) 
    });

    const response = new Response(googleResponse.body, googleResponse);
    if (isAllowedOrigin) response.headers.set('Access-Control-Allow-Origin', origin);
    return response;

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 에러: " + err.message }), { status: 500 });
  }
}
