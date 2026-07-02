import fetch from 'node-fetch'; // or built-in fetch since Node 18+
async function runTest() {
  const baseUrl = 'http://localhost:8081/api';
  console.log("Starting integration test for library return approval flow...");
  // Helper to extract cookie from response headers
  function getCookie(res) {
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) return null;
    return setCookie.split(';')[0];
  }
  // 1. Login as Student
  console.log("\n1. Logging in as student...");
  const loginStudentRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'student', password: 'student123' })
  });
  if (!loginStudentRes.ok) {
    console.error("Student login failed:", await loginStudentRes.text());
    return;
  }
  const studentCookie = getCookie(loginStudentRes);
  const studentInfo = await loginStudentRes.json();
  console.log("Logged in as student:", studentInfo.name);
  // 2. Get student's active issues
  console.log("\n2. Fetching student issues...");
  const studentIssuesRes = await fetch(`${baseUrl}/library/issues`, {
    headers: { 'Cookie': studentCookie }
  });
  const studentIssues = await studentIssuesRes.json();
  
  // Find an active issue (status: issued)
  let activeIssue = studentIssues.find(i => i.status === 'issued');
  if (!activeIssue) {
    console.log("No active issues found for student. Let's see if there is any library book we can request/issue...");
    // Let's query books
    const booksRes = await fetch(`${baseUrl}/library/books`, {
      headers: { 'Cookie': studentCookie }
    });
    const books = await booksRes.json();
    const availableBook = books.find(b => b.availableCopies > 0);
    if (!availableBook) {
      console.error("No books available in library to issue!");
      return;
    }
    console.log(`Found available book: "${availableBook.title}" (ID: ${availableBook.id}). Requesting it...`);
    
    // Request book
    const requestRes = await fetch(`${baseUrl}/library/books/${availableBook.id}/request`, {
      method: 'POST',
      headers: { 'Cookie': studentCookie }
    });
    if (!requestRes.ok) {
      console.error("Failed to request book:", await requestRes.text());
      return;
    }
    const requestInfo = await requestRes.json();
    console.log("Requested book successfully. Request ID:", requestInfo.id);
    // Now log in as Librarian to issue it
    console.log("\nLogging in as librarian to issue the requested book...");
    const loginLibRes1 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'librarian', password: 'librarian123' })
    });
    const librarianCookie1 = getCookie(loginLibRes1);
    
    const issueRes = await fetch(`${baseUrl}/library/requests/${requestInfo.id}/issue`, {
      method: 'POST',
      headers: { 
        'Cookie': librarianCookie1,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ dueDate: new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0] })
    });
    if (!issueRes.ok) {
      console.error("Librarian failed to issue book:", await issueRes.text());
      return;
    }
    const issueInfo = await issueRes.json();
    activeIssue = issueInfo.issuance;
    console.log(`Issued book successfully! Issuance ID: ${activeIssue.id}`);
  } else {
    console.log(`Found active issue ID: ${activeIssue.id} for book: "${activeIssue.bookTitle}"`);
  }
  // Record initial book state
  const booksRes = await fetch(`${baseUrl}/library/books`, {
    headers: { 'Cookie': studentCookie }
  });
  const books = await booksRes.json();
  const bookBefore = books.find(b => b.id === activeIssue.bookId);
  const copiesBefore = bookBefore ? bookBefore.availableCopies : 0;
  console.log(`Book available copies before return request: ${copiesBefore}`);
  // 3. Student requests return
  console.log(`\n3. Student requesting return for issue ID: ${activeIssue.id}...`);
  const returnRequestRes = await fetch(`${baseUrl}/library/issues/${activeIssue.id}`, {
    method: 'PATCH',
    headers: { 
      'Cookie': studentCookie,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ returnDate: new Date().toISOString().split('T')[0] })
  });
  if (!returnRequestRes.ok) {
    console.error("Student return request failed:", await returnRequestRes.text());
    return;
  }
  const returnedRequestInfo = await returnRequestRes.json();
  console.log("Returned request response status:", returnedRequestInfo.status);
  if (returnedRequestInfo.status !== 'return_pending') {
    console.error("FAILED: Status should be 'return_pending' but got", returnedRequestInfo.status);
    return;
  }
  console.log("SUCCESS: Student successfully updated status to 'return_pending'.");
  // Verify available copies of the book did NOT change yet
  const booksRes2 = await fetch(`${baseUrl}/library/books`, {
    headers: { 'Cookie': studentCookie }
  });
  const books2 = await booksRes2.json();
  const bookMid = books2.find(b => b.id === activeIssue.bookId);
  const copiesMid = bookMid ? bookMid.availableCopies : 0;
  console.log(`Book available copies after student return request (should be unchanged): ${copiesMid}`);
  if (copiesMid !== copiesBefore) {
    console.error("FAILED: Copies should not have incremented yet!");
    return;
  }
  console.log("SUCCESS: Available copies remained unchanged.");
  // 4. Librarian login to approve
  console.log("\n4. Logging in as librarian to approve the return...");
  const loginLibRes = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'librarian', password: 'librarian123' })
  });
  if (!loginLibRes.ok) {
    console.error("Librarian login failed:", await loginLibRes.text());
    return;
  }
  const librarianCookie = getCookie(loginLibRes);
  const librarianInfo = await loginLibRes.json();
  console.log("Logged in as librarian:", librarianInfo.name);
  // Approve return
  console.log(`Approving return for issue ID: ${activeIssue.id}...`);
  const approveRes = await fetch(`${baseUrl}/library/issues/${activeIssue.id}`, {
    method: 'PATCH',
    headers: { 
      'Cookie': librarianCookie,
      'Content-Type': 'application/json'
    }
  });
  if (!approveRes.ok) {
    console.error("Librarian failed to approve return:", await approveRes.text());
    return;
  }
  const approvedInfo = await approveRes.json();
  console.log("Approved response status:", approvedInfo.status);
  if (approvedInfo.status !== 'returned') {
    console.error("FAILED: Status should be 'returned' but got", approvedInfo.status);
    return;
  }
  console.log("SUCCESS: Librarian successfully approved the return (status changed to 'returned').");
  // Verify copies incremented
  const booksRes3 = await fetch(`${baseUrl}/library/books`, {
    headers: { 'Cookie': studentCookie }
  });
  const books3 = await booksRes3.json();
  const bookAfter = books3.find(b => b.id === activeIssue.bookId);
  const copiesAfter = bookAfter ? bookAfter.availableCopies : 0;
  console.log(`Book available copies after librarian approval: ${copiesAfter}`);
  if (copiesAfter !== copiesBefore + 1) {
    console.error(`FAILED: Copies should have incremented to ${copiesBefore + 1} but got ${copiesAfter}`);
    return;
  }
  console.log("SUCCESS: Available copies successfully incremented by 1.");
  console.log("\nALL TESTS PASSED SUCCESSFULLY! The flow is 100% correct.");
}
runTest().catch(err => console.error("Error during integration test:", err));