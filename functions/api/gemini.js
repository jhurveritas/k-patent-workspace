export async function onRequest(context) {
  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API 키가 설정되지 않았습니다." }), { status: 400 });
    }

    const requestBody = await context.request.json();
    
    // 임시로 안정적인 2.5 Pro 모델을 사용합니다.
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    const googleResponse = await fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    // 💡 핵심: 구글 서버의 응답(스트리밍 설정)을 훼손하지 않고 그대로 복사해서 전달
    const response = new Response(googleResponse.body, googleResponse);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 에러: " + err.message }), { status: 500 });
  }
}





