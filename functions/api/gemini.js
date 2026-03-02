export async function onRequest(context) {
  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API 키가 설정되지 않았습니다." }), { status: 400 });
    }

    const requestBody = await context.request.json();
    
    // 💡 URL의 모델 이름은 현재 성공하신 모델(예: gemini-2.5-pro 등)로 맞춰주세요!
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    return new Response(googleResponse.body, {
      status: googleResponse.status,
      headers: { 
        'Content-Type': 'text/event-stream', 
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // 💡 핵심: 클라우드플레어에게 데이터 모으지 말고 즉시 배출하라고 명령!
        'Access-Control-Allow-Origin': '*' 
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 에러: " + err.message }), { status: 500 });
  }
}
