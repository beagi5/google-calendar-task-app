import React from 'react';

const LoginPage = () => {
  const handleLogin = () => {
    // Redirect to the Google login page
    window.location.href = '/auth/google';
  };

  return (
    <div style={{ padding: '20px' }}>
      <h2>Login Required</h2>
      <p>You were redirected here because authentication failed or is required.</p>
      <p>Please try again.</p>
      <button onClick={handleLogin}>Login with Google</button>
    </div>
  );
};

export default LoginPage;
