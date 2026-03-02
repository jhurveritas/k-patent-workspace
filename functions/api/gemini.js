export async function onRequest(context) {
  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "클라우드플레어에 API 키가 설정되지 않았습니다." }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const requestBody = await context.request.json();
    
    // 💡 변경점 1: URL을 generateContent 대신 streamGenerateContent?alt=sse 로 변경
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    // 💡 변경점 2: JSON으로 묶고 기다리지 않고, 응답(스트림) 자체를 바로 클라이언트로 흘려보냄
    return new Response(googleResponse.body, {
      status: googleResponse.status,
      headers: { 
        'Content-Type': 'text/event-stream', // 스트리밍 전용 헤더
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*' 
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 자체 에러: " + err.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}

