export async function onRequest(context) {
  // 💡 1. 허용할 도메인 목록
  const allowedOrigins = [
    "https://k-patent-workspace.pages.dev",
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:5500"
  ];

  const origin = context.request.headers.get("Origin");
  const isAllowedOrigin = allowedOrigins.includes(origin);

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

  // 🔥 구글 File API 고속 업로드 헬퍼 함수
  async function uploadToGemini(fileData, apiKey) {
    const binaryString = atob(fileData.base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': fileData.mimeType },
      body: bytes.buffer
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`File API 업로드 실패: ${errText}`);
    }
    
    const data = await res.json();
    return { fileUri: data.file.uri, mimeType: fileData.mimeType, name: fileData.name };
  }

  try {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "API 키 없음" }), { status: 400 });

    const requestBody = await context.request.json();

    const responseHeaders = new Headers();
    if (allowedOrigins.includes(origin)) responseHeaders.set('Access-Control-Allow-Origin', origin);
    responseHeaders.set('Content-Type', 'text/event-stream');
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');

    const encoder = new TextEncoder();

    // =========================================================================
    // 🚀 [최종 해결책] TransformStream과 waitUntil을 버리고, 
    // ReadableStream을 직접 생성하여 클라우드플레어의 간섭을 원천 차단합니다.
    // =========================================================================
    const stream = new ReadableStream({
      async start(controller) {
        // 1. 스트림 파이프가 열리자마자 2KB 쓰레기 데이터를 밀어넣어 버퍼를 강제로 뚫습니다.
        const prelude = ": " + " ".repeat(2048) + "\n\n";
        controller.enqueue(encoder.encode(prelude));

        // 2. 15초마다 안전하게 심장박동을 쏩니다.
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive " + " ".repeat(512) + "\n\n"));
          } catch (e) {
            clearInterval(keepAlive);
          }
        }, 15000);

        try {
          let geminiPayload = requestBody;

          // 🛡️ [청구항 대조기]
          if (requestBody.type === 'compare') {
            const { krText, enText } = requestBody.data;
            const systemInstruction = `
              당신은 한국 특허 실무와 글로벌(USPTO/EPO) 특허 표준을 모두 꿰뚫고 있는 세계 최고 수준의 기술 번역 전문가입니다.
              당신의 임무는 한국어 특허 청구항의 영문 번역본을 분석하여 정확성, 법적 효력, 기술적 일관성을 검증하는 것입니다.

              [출력 지시사항 - 매우 중요]
              1. JSON이 아닌, 읽기 편한 일반 마크다운(Markdown) 형식으로 작성하십시오.
              2. 문제가 없는 정상적인 청구항은 분석을 생략하십시오.
              3. 오역, 권리 범위 불일치, 누락이 발생한 청구항만 번호를 명시하고, [발생 위치], [문제 진단], [수정 권고안]을 정리하여 즉시 출력하십시오.

              🚨 [시스템 긴급 지시사항 - 타임아웃 방지] 🚨
              전체 청구항을 다 읽고 분석을 끝낼 때까지 절대로 침묵하며 기다리지 마십시오.
              무조건 "🔍 **한/영 청구항 교차 검증을 시작합니다...**\n\n" 라는 문장을 최우선으로 0.1초 만에 즉시 출력하십시오. 
              반드시 이 안내 문구를 먼저 뱉어낸 후에, 1번 청구항부터 순차적으로 읽어 내려가며 본문 작성을 이어가십시오.
            `;
            const promptText = `KOREAN CLAIM (한국어 원문):\n${krText}\n\nENGLISH TRANSLATION (영문 번역본):\n${enText}`;

            geminiPayload = { 
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: [{ text: promptText }] }], 
              generationConfig: { 
                temperature: 0.1,
                maxOutputTokens: 8192
              } 
            };
          }
          
          // 🛡️ [의견서 생성기]
          else if (requestBody.type === 'draft') {
            const { originalContext, amendmentContext, userDraftResponse, userTemplate } = requestBody.data;
            const secretPrompt = `너는 KIPO(한국특허청) 양식에 능통한 최고 수준의 전문 특허 명세사야. 제공된 템플릿의 문체와 양식을 엄격하게 준수하여 아래 자료를 바탕으로 최종 특허 의견서/보정서를 작성해줘. 여기서, 사용자가 제공한 대응논리는 최대한 누락하지 않게 반영하고, 결과물 출력시 "**"표시는 안나오게 해줘. 또한, 결과물 출력시에 맨 마지막에는 AI가 살을 붙이거나 논리를 더 구체화한 부분을 설명해주고, 보정 후 청구항에 기재불비 사항이 있는지 점검해줘.\n\n[특허청 통지서 원문]\n${originalContext}\n\n[보정서 원문]\n${amendmentContext || '입력되지 않음'}\n\n[대응 초안 (핵심 논리)]\n${userDraftResponse}\n\n[작성 템플릿]\n${userTemplate}\n\n[🚨시스템 긴급 지시사항🚨]\n네트워크 타임아웃을 방지하기 위해, 글의 전체 구조를 다 생각할 때까지 기다리지 마. 무조건 "✍️ 제공된 문헌을 바탕으로 의견서 초안 작성을 시작합니다...\n\n" 라는 문장을 0.1초 만에 최우선으로 즉시 출력해. 이 문장을 먼저 뱉고 난 후에 본문 작성을 이어가.`;
            geminiPayload = { contents: [{ role: "user", parts: [{ text: secretPrompt }] }] };
          }

          // 🛡️ [IDS 판별기]
          else if (requestBody.type === 'ids') {
            const { historyFiles, targetFiles, textInput } = requestBody.data;
            
            const uploadPromises = [];
            if (historyFiles) historyFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'history' }))));
            if (targetFiles) targetFiles.forEach(f => uploadPromises.push(uploadToGemini(f, apiKey).then(res => ({ ...res, type: 'target' }))));

            const uploadedFiles = await Promise.all(uploadPromises);
            
            let parts = [];
            uploadedFiles.forEach(f => {
              parts.push({ text: f.type === 'history' ? `\n--- [History (기존 제출 문헌) 파일명: ${f.name}] 시작 ---\n` : `\n--- [Target (신규 인용 문헌) 파일명: ${f.name}] 시작 ---\n` });
              parts.push({ fileData: { fileUri: f.fileUri, mimeType: f.mimeType } });
              parts.push({ text: f.type === 'history' ? `\n--- [History 파일명: ${f.name}] 끝 ---\n` : `\n--- [Target 파일명: ${f.name}] 끝 ---\n` });
            });

            parts.push({ 
              text: `너는 특허 정보 분석 전문가야. 위 제공된 문서들을 바탕으로 다음 [작업 순서]를 엄격히 준수하여 분석해.

[작업 순서]
1. 먼저, [Target] 문서들과 사용자가 수동으로 입력한 텍스트("${textInput || '입력 없음'}")만 샅샅이 뒤져서 '새롭게 인용된 선행기술문헌(특허번호 및 NPL)'을 모조리 추출해. (이것이 '기준 목록'이 된다. 절대로 History 문서에서 문헌을 먼저 추출하지 마라.)
2. 그 다음, 방금 만든 '기준 목록'의 각 문헌들이 [History] 문서들 내용 안에 이미 기재되어 있는지 하나하나 교차 검증(Cross-check)해.
3. 해당 문헌이 [History] 문서에서 하나라도 발견되었다면 상태를 "ALREADY_FILED"로, 어떤 History 문서에도 없다면 "NEW"로 판별해.

반드시 아래 JSON 배열 형식으로만 응답해 (마크다운 없이 순수 JSON만 출력):
[
  {
    "id": "문헌 번호 (예: US-11223344-B2, JP-2020-12345-A 등)",
    "type": "Patent" 혹은 "NPL",
    "status": "NEW" 혹은 "ALREADY_FILED",
    "source": "해당 문헌을 발견한 Target 문서명 또는 출처 페이지",
    "historyFile": "ALREADY_FILED인 경우 해당 문헌이 발견된 History 파일의 정확한 이름 (NEW인 경우에는 null) (History 파일이 여러개인 경우 '/'로 구분하여 표시하고, 그 중 발행날짜가 가장 빠른 것은 빨간색으로 강조표시할 것)"
  }
]` 
            });

            geminiPayload = { 
              contents: [{ role: "user", parts: parts }], 
              generationConfig: { responseMimeType: "application/json", temperature: 0.1 } 
            };
          }
          
          // 🛡️ [국가별 OA 논리 검토기]
          else if (requestBody.type === 'oa_review') {
            const { targetCountry, originalSpecification, officeAction, pendingClaims, amendedClaims, userDraftResponse } = requestBody.data;
            
            // 💡 [해결 로직 추가] 정규식을 사용하여 XML/HTML 태그를 모두 제거하고 다중 공백을 하나로 압축합니다.
            const cleanSpec = originalSpecification ? originalSpecification.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
            const cleanPending = pendingClaims ? pendingClaims.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
            const cleanAmended = amendedClaims ? amendedClaims.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

            const prompt = `너는 ${targetCountry} 특허법 및 심사실무에 능통한 최고 수준의 특허 명세사야. 
            아래 제공된 분석 자료들을 바탕으로 아래 지시사항과 같은 분석을 해주고, 반드시 아래 JSON 형식으로만 응답해줘.
            
            [분석 자료]
            - 대상 국가: ${targetCountry}
            - 최초명세서: ${cleanSpec}
            - 계류중 청구항: ${cleanPending}
            - 보정 후 청구항: ${cleanAmended}
            - 대응 초안(핵심 논리): ${userDraftResponse}

            [지시사항]
            1. 거절이유 통지서(첨부파일)의 지적 사항과 사용자의 대응 초안을 비교하여 누락된 대응 논리가 있는지 분석하세요.
            2. 보정 후 청구항과 대응 초안의 주장이 일치하는지 분석하세요.
            3. 보정 후 청구항에 명확성 결여, 신규사항 추가 등 기재불비 사항이 있는지, 그리고 청구항 간 상충되는 내용이 발생하는지 분석하세요. 이때, 선택된 대상 국가의 특유한 제도 등을 고려해주세요.
            예를 들면, 미국에서는 MPEP, 35 U.S.C. 101, 102, 103, 112 등을 고려하고, 유럽에서는 MPEP, 35 U.S.C. 101, 102, 103, 112, Intermediate Generalization 등을 고려해주세요.
            (주의: '보정 후 청구항' 란에 보정된 일부 청구항만 기재되어 있는 경우, 기재되지 않은 나머지 청구항은 '현재 계류 중인 청구항'과 동일한 것으로 간주하여 전체 청구항 세트를 기준으로 기재불비 및 청구항 간 상충 여부를 종합적으로 판단하세요.)
            4. 단, 종속항에 대한 진보성(Inventive Step / Non-obviousness) 판단은 논리 검토 대상에서 제외하세요.
            5. 신규사항 추가 이슈는 중국과 유럽은 가장 엄격하게 봐주고, 미국,일본 및 한국은 지적은 해주되 도면이나 발명의 설명으로부터 도출 가능한 정도라면 괜찮다는 문구를 추가해주세요.
             
            [요구되는 JSON 응답 포맷 (반드시 지킬 것)]
            {
              "isComplete": boolean (완벽한 방어 논리인지 여부),
              "missingPoints": [{"point": "지적 사항 요약", "suggestion": "보완 제안 내용"}],
              "claimDiscrepancies": [{"issue": "불일치 문제점", "suggestion": "해결 제안 내용"}],
              "descriptionDeficiencies": [{"issue": "기재불비 문제점", "suggestion": "해결 제안 내용"}]
            }`;

            let parts = [{ text: prompt }];

            if (officeAction) {
              const uploadedOA = await uploadToGemini(officeAction, apiKey);
              parts.push({ fileData: { fileUri: uploadedOA.fileUri, mimeType: uploadedOA.mimeType } });
              parts.push({ text: `[거절이유 / 통지서 원문 파일: ${uploadedOA.name}]` });
            }

            geminiPayload = { contents: [{ role: "user", parts: parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } };
          }

          // 🚀 구글 제미나이 본 요청 시작
          const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
          let googleResponse;
          const maxRetries = 2; // 최대 2번 더 재시도 (총 3번 호출)
          
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            googleResponse = await fetch(googleUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(geminiPayload) 
            });

            // 503(과부하) 에러가 아니거나, 요청이 성공했다면 루프 탈출
            if (googleResponse.ok || googleResponse.status !== 503) {
              break;
            }

            // 503 에러이고 아직 재시도 기회가 남았다면 2초 대기 후 다시 찌르기
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          if (!googleResponse.ok) {
            const errText = await googleResponse.text();
            // 에러 메시지를 JSON.stringify로 감싸서 안전하게 전송
            const safeErrorMsg = JSON.stringify(`API 에러 (${googleResponse.status}): ${errText}`);
            controller.enqueue(encoder.encode(`data: {"error": ${safeErrorMsg}}\n\n`));
            clearInterval(keepAlive);
            try { controller.close(); } catch(e) {}
            return;
          }

          // 정상적으로 응답이 오면 스트림을 연결합니다.
          const reader = googleResponse.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }

        } catch (err) {
          // 🔥 [수정된 부분] 백엔드 자체 에러도 안전하게 포장합니다!
          const safeErrorMsg = JSON.stringify(`백엔드 에러: ${err.message}`);
          controller.enqueue(encoder.encode(`data: {"error": ${safeErrorMsg}}\n\n`));
        } finally {
          clearInterval(keepAlive);
          try { controller.close(); } catch (e) {}
        }
      }
    });

    // =========================================================================
    // 💡 기다리지 않고 곧바로 stream을 반환합니다. 
    // ReadableStream 구조이기 때문에 Cloudflare가 즉시 200 OK 헤더를 프론트엔드로 쏩니다!
    // =========================================================================
    return new Response(stream, { status: 200, headers: responseHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: "초기화 에러: " + err.message }), { status: 500 });
  }
}
