import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Login from './components/Login';
import Candidate from './components/Candidate';
import Proctor from './components/Proctor';
import './App.css';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    const savedUser = localStorage.getItem('proctorUser');
    if (savedUser) {
      const parsedUser = JSON.parse(savedUser);
      console.log('User loaded from localStorage:', parsedUser);
      setUser(parsedUser);
    }
    setLoading(false);
  }, []);

  // Debug user state changes
  useEffect(() => {
    console.log('User state changed:', user);
  }, [user]);

  const handleLogin = (userData) => {
    console.log('User logged in:', userData);
    setUser(userData);
    localStorage.setItem('proctorUser', JSON.stringify(userData));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('proctorUser');
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  // Debug information
  console.log('App render - User:', user, 'Loading:', loading);

  return (
    <Router>
      <div className="App">
        {/* Debug information - remove in production */}
        {process.env.NODE_ENV === 'development' && (
          <div style={{ 
            position: 'fixed', 
            top: '10px', 
            right: '10px', 
            background: 'rgba(0,0,0,0.8)', 
            color: 'white', 
            padding: '10px', 
            borderRadius: '5px',
            fontSize: '12px',
            zIndex: 9999
          }}>
            <div>User: {user ? user.role : 'null'}</div>
            <div>Loading: {loading ? 'true' : 'false'}</div>
          </div>
        )}
        <Routes>
          <Route 
            path="/" 
            element={
              user ? (
                (() => {
                  console.log('Current user role:', user.role);
                  if (user.role === 'student') {
                    console.log('Redirecting student to /candidate');
                    return <Navigate to="/candidate" replace />;
                  } else if (user.role === 'invigilator') {
                    console.log('Redirecting invigilator to /proctor');
                    return <Navigate to="/proctor" replace />;
                  } else {
                    console.log('Unknown role, staying on login');
                    return <Login onLogin={handleLogin} />;
                  }
                })()
              ) : (
                <Login onLogin={handleLogin} />
              )
            } 
          />
          <Route 
            path="/candidate" 
            element={
              user && user.role === 'student' ? 
                <Candidate user={user} onLogout={handleLogout} /> : 
                <Navigate to="/" replace />
            } 
          />
          <Route 
            path="/proctor" 
            element={
              user && user.role === 'invigilator' ? 
                <Proctor user={user} onLogout={handleLogout} /> : 
                <Navigate to="/" replace />
            } 
          />
          {/* Fallback route for any unmatched paths */}
          <Route 
            path="*" 
            element={<Navigate to="/" replace />} 
          />
        </Routes>
      </div>
    </Router>
  );
}

export default App;