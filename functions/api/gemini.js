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
    let geminiPayload = requestBody; 

   // 🛡️ [청구항 대조기] - 완벽한 JSON 스키마 적용
    if (requestBody.type === 'compare') {
      const { krText, enText } = requestBody.data;
      
      const systemInstruction = `
        당신은 한국 특허 실무와 글로벌(USPTO/EPO) 특허 표준을 모두 꿰뚫고 있는 세계 최고 수준의 특허 변리사 및 기술 번역 전문가입니다.
        당신의 임무는 한국어 특허 청구항의 영문 번역본을 분석하여 정확성, 법적 효력, 기술적 일관성을 검증하는 것입니다.

        분석 시 다음 사항에 집중하세요:
        1. 각 오류나 불일치가 발생하는 '위치'를 정확히 식별하십시오 (예: 전제부(Preamble), 구성요소 1, 특징부, 전이구 등).
        2. 법적 권리 범위 (Legal Scope): 영문 번역이 원본 한국어 청구항의 범위를 부당하게 넓히거나 좁히지 않았는가?
        3. 용어의 정확성 (Terminology): 기술 용어가 산업 표준 영문 용어로 정확하게 번역되었는가?
        4. 구조적 무결성: USPTO/EPO 표준 형식을 따르고 있는가?
        5. 완전성: 한국어 원문의 모든 한정 사항이 영문에 반영되었는가?

        중요: 
        - 'discrepancies' 배열 내의 각 항목은 청구항 내의 구체적인 '위치(locationIndicator)'를 포함해야 합니다.
        - 모든 분석 내용(summary, comment, suggestion, issue)은 한국어로 작성하십시오.
        - 한국인 전문가가 '어느 부분에서 어떤 문제가 발생했는지' 한눈에 알 수 있도록 위치 식별을 명확히 하십시오.
      `;

      const promptText = `KOREAN CLAIM (한국어 원문):\n${krText}\n\nENGLISH TRANSLATION (영문 번역본):\n${enText}`;

      geminiPayload = { 
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: promptText }] }], 
        generationConfig: { 
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              overallScore: { type: "NUMBER" },
              summary: { type: "STRING" },
              checks: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    category: { type: "STRING" },
                    status: { type: "STRING", enum: ["Pass", "Warning", "Fail"] },
                    comment: { type: "STRING" },
                    suggestion: { type: "STRING" }
                  },
                  required: ["category", "status", "comment"]
                }
              },
              discrepancies: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    locationIndicator: { type: "STRING" },
                    koreanSegment: { type: "STRING" },
                    englishSegment: { type: "STRING" },
                    issue: { type: "STRING" },
                    severity: { type: "STRING", enum: ["Low", "Medium", "High", "Critical"] },
                    recommendedFix: { type: "STRING" }
                  },
                  required: ["locationIndicator", "koreanSegment", "englishSegment", "issue", "severity", "recommendedFix"]
                }
              }
            },
            required: ["overallScore", "summary", "checks", "discrepancies"]
          }
        } 
      };
    }
    
    // 🛡️ [의견서 생성기]
    else if (requestBody.type === 'draft') {
      const { originalContext, amendmentContext, userDraftResponse, userTemplate } = requestBody.data;
      const secretPrompt = `너는 KIPO(한국특허청) 양식에 능통한 전문 특허 명세사야. 제공된 템플릿의 문체와 양식을 엄격하게 준수하여 아래 자료를 바탕으로 최종 특허 의견서/보정서를 작성해줘. 여기서, 결과물 출력시 "**"표시는 안나오게 해줘.\n\n[특허청 통지서 원문]\n${originalContext}\n\n[보정서 원문]\n${amendmentContext || '입력되지 않음'}\n\n[대응 초안 (핵심 논리)]\n${userDraftResponse}\n\n[작성 템플릿]\n${userTemplate}`;
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
      
      // 1. 파일 데이터를 명확한 꼬리표와 함께 먼저 주입
      uploadedFiles.forEach(f => {
        parts.push({ text: f.type === 'history' ? `\n--- [History (기존 제출 문헌) 파일명: ${f.name}] 시작 ---\n` : `\n--- [Target (신규 인용 문헌) 파일명: ${f.name}] 시작 ---\n` });
        parts.push({ fileData: { fileUri: f.fileUri, mimeType: f.mimeType } });
        parts.push({ text: f.type === 'history' ? `\n--- [History 파일명: ${f.name}] 끝 ---\n` : `\n--- [Target 파일명: ${f.name}] 끝 ---\n` });
      });

      // 2. 강력한 단계별 지시사항
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
      
      const prompt = `너는 ${targetCountry} 특허법 및 심사실무에 능통한 최고 수준의 특허 명세사야. 
      아래 제공된 분석 자료들을 바탕으로 아래 지시사항과 같은 분석을 해주고, 반드시 아래 JSON 형식으로만 응답해줘.
      
      [분석 자료]
      - 대상 국가: ${targetCountry}
      - 최초명세서: ${originalSpecification}
      - 계류중 청구항: ${pendingClaims}
      - 보정 후 청구항: ${amendedClaims}
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

    // 🔥 여기서부터가 524 타임아웃 완벽 방어 코드로 통합된 부분입니다. 🔥
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse&key=${apiKey}`;
    
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 1. 10초마다 브라우저에 "나 아직 통신 중이야"라는 빈 신호(Heartbeat 주석) 전송
    const keepAliveInterval = setInterval(() => {
      writer.write(encoder.encode(": keepalive\n\n")); 
    }, 10000);

    // 2. 구글 API 호출 (백그라운드에서 실행)
    fetch(googleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload) 
    }).then(async (googleResponse) => {
      if (!googleResponse.ok) {
        const errText = await googleResponse.text();
        writer.write(encoder.encode(`data: {"error": "${errText}"}\n\n`));
        return;
      }
      
      const reader = googleResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value); // 구글에서 데이터가 오면 바로 프론트엔드로 전달
      }
    }).catch((err) => {
      console.error("Fetch 에러:", err);
    }).finally(() => {
      clearInterval(keepAliveInterval); // 통신 끝나면 심장박동 중지
      writer.close(); // 파이프라인 닫기
    });

    // 3. 구글의 응답을 기다리지 않고 프론트엔드로 파이프라인 즉시 반환
    const responseHeaders = new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    if (isAllowedOrigin) responseHeaders.set('Access-Control-Allow-Origin', origin);

    return new Response(readable, { headers: responseHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: "백엔드 에러: " + err.message }), { status: 500 });
  }
}
