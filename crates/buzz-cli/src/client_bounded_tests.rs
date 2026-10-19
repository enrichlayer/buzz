//! Exercise capped transport against incomplete real HTTP bodies.
use super::BuzzClient;
use nostr::Keys;
use serde_json::json;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn capped_reads_stop_before_eof_for_metadata_query_and_error_bodies() {
    for query in [false, true] {
        for status in [200, 403] {
            for chunked in [false, true] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://{}", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                        let mut buffer = [0; 1024];
                        let read = socket.read(&mut buffer).await.unwrap();
                        assert_ne!(read, 0);
                        request.extend_from_slice(&buffer[..read]);
                        assert!(request.len() < 16384);
                    }
                    let framing = if chunked {
                        "Transfer-Encoding: chunked"
                    } else {
                        "Content-Length: 33"
                    };
                    socket
                        .write_all(
                            format!(
                                "HTTP/1.1 {status} Test\r\n{framing}\r\nConnection: close\r\n\r\n"
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    if chunked {
                        socket.write_all(b"21\r\n").await.unwrap();
                    }
                    // Never send EOF or the terminating chunk. Buffering the full
                    // response before checking its size must fail this test.
                    let _ = socket.write_all(&[b'x'; 33]).await;
                    if chunked {
                        let _ = socket.write_all(b"\r\n").await;
                    }
                    std::future::pending::<()>().await;
                });
                let client = BuzzClient::new(url, Keys::generate(), None, None).unwrap();
                let result = tokio::time::timeout(Duration::from_secs(5), async {
                    if query {
                        client.query_bounded(&json!({"kinds":[0]}), 32).await
                    } else {
                        client.get_public_bounded("/", 32).await
                    }
                })
                .await;
                server.abort();
                let error = result
                    .expect("read must reject before waiting for response EOF")
                    .unwrap_err();
                assert!(
                    error.to_string().contains("exceeds 32 byte limit"),
                    "{query} {status} {chunked}: {error}"
                );
            }
        }
    }
}
