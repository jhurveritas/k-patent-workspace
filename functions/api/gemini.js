export async function onRequest(context) {
  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
      // API 키가 없으면 에러 메시지를 JSON으로 반환
      return new Response(JSON.stringify({ error: "클라우드플레어에 API 키가 설정되지 않았습니다." }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const requestBody = await context.request.json();
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await googleResponse.json();

    return new Response(JSON.stringify(data), {
      status: googleResponse.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    // 백엔드가 터져도 텅 빈 응답 대신 에러 내용을 보냄
    return new Response(JSON.stringify({ error: "백엔드 자체 에러: " + err.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

}









